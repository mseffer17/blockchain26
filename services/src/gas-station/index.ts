/**
 * GAS STATION — Swissquote's bundler + paymaster signer.                         [MOCKED INFRASTRUCTURE]
 *
 * Real ERC-4337: it calls the real EntryPoint v0.8 `handleOps` and signs sponsorships that the real
 * on-chain RutliPaymaster verifies. What is simplified: a single private bundler instead of the public
 * ERC-4337 mempool (Pimlico/Alchemy could replace it without any contract change).
 *
 * Who pays: Swissquote (the paymaster's deposit in the EntryPoint).
 * Abuse prevention:
 *   - only Rütli accounts (clones of our implementation, or initCode from our factory) are sponsored;
 *   - monthly quota per account; security operations (freeze, recovery, cancellations) are always free;
 *   - every operation is simulated before sponsoring: Swissquote never pays for a failing operation;
 *   - passkey-only payments to sanctioned addresses are not sponsored;
 *   - sponsorships are bound to one exact operation and expire (15 min; 48 h for co-signer holds).
 */
import {
  concatHex,
  numberToHex,
  pad,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import {
  NonceLane,
  decodeAccountCall,
  deserializeUserOp,
  entryPointAbi,
  getUserOpHash,
  packAccountGasLimits,
  packGasFees,
  rutliAccountAbi,
  rutliFactoryAbi,
  rutliPaymasterAbi,
  serializeUserOp,
  toEntryPointTuple,
  type PackedUserOp,
  type SerializedUserOp,
} from '@rutli/sdk';
import { loadDeployment } from '../common/config';
import { chainNow, publicClient, walletClient } from '../common/chain';
import { decodeRevert, entryPointFailure, extractRevertData } from '../common/errors';
import { HttpError, createApp, requireInternal, start } from '../common/http';
import { accountOf, ensureKeys } from '../common/keys';
import { screen } from '../common/sanctions';
import { JsonStore } from '../common/store';

const SERVICE = 'gas-station' as const;
const d = loadDeployment();
const keys = await ensureKeys(SERVICE);
const bundler = accountOf(keys.bundlerPrivateKey);
const sponsor = accountOf(keys.sponsorPrivateKey);
const pc = publicClient(d);
const wc = walletClient(d, bundler);
const EP = d.contracts.entryPoint;

const MONTHLY_QUOTA = Number(process.env.GAS_MONTHLY_QUOTA ?? 200);
const SECURITY_KINDS = new Set([
  'freeze',
  'unfreeze',
  'rotatePasskey',
  'rotateCard',
  'initiateRecovery',
  'cancelRecovery',
  'initiateExit',
  'cancelExit',
]);

interface OpRecord {
  userOpHash: Hex;
  sender: Address;
  kind: string;
  txHash?: Hex;
  success?: boolean;
  error?: string;
  gasCostWei?: string;
  at: number;
}

const db = new JsonStore(SERVICE, 'db', () => ({
  quota: {} as Record<string, { month: string; count: number }>,
  ops: [] as OpRecord[],
  deployments: [] as Array<{ account: Address; txHash: Hex; at: number }>,
}));

// One transaction at a time from the bundler EOA (no nonce races).
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function isRutliAccount(address: Address): Promise<boolean> {
  const code = await pc.getCode({ address });
  return !!code && code.toLowerCase().includes(d.contracts.implementation.slice(2).toLowerCase());
}

function factoryOf(initCode: Hex): Address | null {
  return initCode.length >= 42 ? (`0x${initCode.slice(2, 42)}` as Address) : null;
}

const month = () => new Date().toISOString().slice(0, 7);

const app = createApp(SERVICE);

/** Fill gas fields, attach a signed sponsorship, return the operation to sign + its hash. */
app.post('/sponsor', async (req, res) => {
  const input = req.body?.op as SerializedUserOp | undefined;
  if (!input) throw new HttpError(400, 'op required');
  const purpose = (req.body?.purpose as string | undefined) ?? 'default';
  const op = deserializeUserOp({ ...input, signature: '0x', paymasterAndData: '0x' });

  // 1. Only Rütli accounts.
  const deployed = await isRutliAccount(op.sender);
  if (!deployed) {
    const f = factoryOf(op.initCode);
    if (!f || f.toLowerCase() !== d.contracts.factory.toLowerCase()) {
      throw new HttpError(403, 'Swissquote only sponsors Rütli wallets');
    }
  }

  // 2. Only known account functions.
  const intent = decodeAccountCall(op.callData);
  if (intent.kind === 'unknown') throw new HttpError(400, 'Unknown wallet operation');
  const security = SECURITY_KINDS.has(intent.kind);

  // 3. Sanctions screening of every counterparty: Swissquote does not relay or pay for payments to sanctioned
  //    addresses, whatever the signatures (the co-signer additionally screens what it co-signs).
  const counterparties: Address[] = [];
  if (intent.kind === 'spend') counterparties.push(intent.to);
  if (intent.kind === 'calls') {
    for (const c of intent.calls) {
      counterparties.push(c.target);
      if (c.erc20?.kind === 'transfer') counterparties.push(c.erc20.to);
      if (c.erc20?.kind === 'approve') counterparties.push(c.erc20.spender);
    }
  }
  for (const a of counterparties) {
    const hit = screen(a);
    if (hit.hit) throw new HttpError(403, `Counterparty is on a sanctions list (${hit.list}: ${hit.entity})`);
  }

  // 4. Quota (security operations are always free).
  if (!security) {
    const q = db.data.quota[op.sender.toLowerCase()];
    if (q && q.month === month() && q.count >= MONTHLY_QUOTA) {
      throw new HttpError(429, `Monthly free-transaction quota reached (${MONTHLY_QUOTA})`);
    }
  }

  // 5. Simulate the execution: Swissquote never pays for an operation that would revert.
  let callGasLimit = 800_000n;
  if (deployed) {
    try {
      const est = await pc.estimateGas({ account: EP, to: op.sender, data: op.callData });
      callGasLimit = (est * 13n) / 10n + 50_000n;
    } catch (e) {
      const decoded = decodeRevert(extractRevertData(e));
      throw new HttpError(422, decoded.message, { error: decoded.name, args: decoded.args?.map(String) });
    }
  }

  const fees = await pc.estimateFeesPerGas();
  const verificationGasLimit = (d.p256Precompile ? 450_000n : 2_500_000n) + (deployed ? 0n : 600_000n);
  const now = await chainNow(pc);
  const validUntil = now + (purpose === 'coffre' ? 48 * 3600 : 15 * 60);
  const validAfter = 0;
  const pmVerificationGas = 120_000n;
  const pmPostOpGas = 0n;

  const sponsored: PackedUserOp = {
    ...op,
    accountGasLimits: packAccountGasLimits(verificationGasLimit, callGasLimit),
    preVerificationGas: 100_000n,
    gasFees: packGasFees(fees.maxPriorityFeePerGas ?? 1_000_000n, (fees.maxFeePerGas ?? 2_000_000_000n) * 2n),
    paymasterAndData: '0x',
  };
  const prefix = concatHex([
    d.contracts.paymaster,
    pad(numberToHex(pmVerificationGas), { size: 16 }),
    pad(numberToHex(pmPostOpGas), { size: 16 }),
    pad(numberToHex(validUntil), { size: 6 }),
    pad(numberToHex(validAfter), { size: 6 }),
  ]);
  sponsored.paymasterAndData = concatHex([prefix, pad('0x', { size: 65 })]);
  const digest = await pc.readContract({
    address: d.contracts.paymaster,
    abi: rutliPaymasterAbi,
    functionName: 'sponsorshipHash',
    args: [toEntryPointTuple(sponsored), validUntil, validAfter],
  });
  const sponsorSig = await sponsor.sign({ hash: digest });
  sponsored.paymasterAndData = concatHex([prefix, sponsorSig]);

  res.json({
    op: serializeUserOp(sponsored),
    userOpHash: getUserOpHash(sponsored, EP, d.chainId),
    sponsoredBy: 'Swissquote',
    free: security ? 'security operations are always free' : `quota ${MONTHLY_QUOTA}/month`,
    validUntil,
  });
});

/** Submit a fully signed operation to the EntryPoint. */
app.post('/send', async (req, res) => {
  const input = req.body?.op as SerializedUserOp | undefined;
  if (!input) throw new HttpError(400, 'op required');
  const op = deserializeUserOp(input);
  if (!op.paymasterAndData.toLowerCase().startsWith(d.contracts.paymaster.toLowerCase())) {
    throw new HttpError(400, 'Only operations sponsored by Swissquote are bundled here');
  }
  const userOpHash = getUserOpHash(op, EP, d.chainId);
  const intent = decodeAccountCall(op.callData);

  const result = await exclusive(async () => {
    try {
      await pc.simulateContract({
        address: EP,
        abi: entryPointAbi,
        functionName: 'handleOps',
        args: [[toEntryPointTuple(op)], bundler.address],
        account: bundler.address,
      });
    } catch (e) {
      const f = entryPointFailure(e);
      throw new HttpError(400, f?.message ?? 'The EntryPoint rejected the operation', {
        code: f?.code,
        reason: f?.reason ?? (e as Error).message.split('\n')[0],
      });
    }
    const txHash = await wc.writeContract({
      address: EP,
      abi: entryPointAbi,
      functionName: 'handleOps',
      args: [[toEntryPointTuple(op)], bundler.address],
    });
    const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
    const logs = parseEventLogs({ abi: entryPointAbi, logs: receipt.logs });
    const event = logs.find((l) => l.eventName === 'UserOperationEvent' && l.args.userOpHash === userOpHash);
    const revert = logs.find((l) => l.eventName === 'UserOperationRevertReason' && l.args.userOpHash === userOpHash);
    const success = event?.eventName === 'UserOperationEvent' ? event.args.success : false;
    const decoded =
      !success && revert?.eventName === 'UserOperationRevertReason' ? decodeRevert(revert.args.revertReason) : undefined;
    const gasCostWei = event?.eventName === 'UserOperationEvent' ? event.args.actualGasCost : undefined;
    return { txHash, success, decoded, gasCostWei, blockNumber: receipt.blockNumber };
  });

  if (!SECURITY_KINDS.has(intent.kind)) {
    db.update((s) => {
      const k = op.sender.toLowerCase();
      const q = s.quota[k];
      s.quota[k] = q && q.month === month() ? { month: q.month, count: q.count + 1 } : { month: month(), count: 1 };
    });
  }
  db.update((s) => {
    s.ops.unshift({
      userOpHash,
      sender: op.sender,
      kind: intent.kind,
      txHash: result.txHash,
      success: result.success,
      error: result.decoded?.message,
      gasCostWei: result.gasCostWei?.toString(),
      at: Date.now(),
    });
    s.ops = s.ops.slice(0, 200);
  });

  res.json({
    userOpHash,
    txHash: result.txHash,
    success: result.success,
    blockNumber: result.blockNumber,
    gasPaidBySwissquoteWei: result.gasCostWei?.toString(),
    error: result.decoded?.message,
    errorName: result.decoded?.name,
  });
});

/** Deploy a wallet for a newly onboarded client (Swissquote pays; it cannot choose the keys: the address commits to them). */
app.post('/deploy', async (req, res) => {
  requireInternal(req);
  const cfg = req.body?.cfg;
  const salt = req.body?.salt as Hex;
  if (!cfg || !salt) throw new HttpError(400, 'cfg and salt required');
  const config = {
    ...cfg,
    allowanceLimits: (cfg.allowanceLimits as string[]).map((x) => BigInt(x)),
  };
  const account = await pc.readContract({
    address: d.contracts.factory,
    abi: rutliFactoryAbi,
    functionName: 'getAddress',
    args: [config, salt],
  });
  const existing = await pc.getCode({ address: account });
  if (existing && existing !== '0x') {
    res.json({ account, alreadyDeployed: true });
    return;
  }
  const txHash = await exclusive(async () => {
    const hash = await wc.writeContract({
      address: d.contracts.factory,
      abi: rutliFactoryAbi,
      functionName: 'createAccount',
      args: [config, salt],
    });
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new HttpError(500, 'deployment failed');
    return hash;
  });
  db.update((s) => s.deployments.unshift({ account, txHash, at: Date.now() }));
  res.json({ account, txHash });
});

/** Anyone may finalize a matured recovery/exit; Swissquote relays it for free. */
app.post('/relay/finalize', async (req, res) => {
  const account = req.body?.account as Address;
  const kind = req.body?.kind as 'recovery' | 'exit';
  if (!account || (kind !== 'recovery' && kind !== 'exit')) throw new HttpError(400, 'account and kind required');
  if (!(await isRutliAccount(account))) throw new HttpError(404, 'not a Rütli wallet');
  const functionName = kind === 'recovery' ? 'finalizeRecovery' : 'finalizeExit';
  const txHash = await exclusive(async () => {
    try {
      await pc.simulateContract({ address: account, abi: rutliAccountAbi, functionName, account: bundler.address });
    } catch (e) {
      throw new HttpError(409, decodeRevert(extractRevertData(e)).message);
    }
    const hash = await wc.writeContract({ address: account, abi: rutliAccountAbi, functionName });
    await pc.waitForTransactionReceipt({ hash });
    return hash;
  });
  res.json({ txHash });
});

app.get('/nonce/:account/:lane', async (req, res) => {
  const lane = BigInt(req.params.lane ?? NonceLane.PORTE_MONNAIE);
  const nonce = await pc.readContract({
    address: EP,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [req.params.account as Address, lane],
  });
  res.json({ nonce: nonce.toString() });
});

app.get('/stats', async (_req, res) => {
  const [deposit, bundlerBalance] = await Promise.all([
    pc.readContract({ address: EP, abi: entryPointAbi, functionName: 'balanceOf', args: [d.contracts.paymaster] }),
    pc.getBalance({ address: bundler.address }),
  ]);
  res.json({
    paymaster: d.contracts.paymaster,
    paymasterDepositWei: deposit.toString(),
    bundler: bundler.address,
    bundlerBalanceWei: bundlerBalance.toString(),
    sponsorSigner: sponsor.address,
    monthlyQuota: MONTHLY_QUOTA,
    sponsoredOps: db.data.ops.length,
    recentOps: db.data.ops.slice(0, 30),
    deployments: db.data.deployments.slice(0, 30),
  });
});

start(app, SERVICE, `Gas station (bundler ${bundler.address}, sponsor signer ${sponsor.address})`);
