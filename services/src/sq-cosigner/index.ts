/**
 * SWISSQUOTE POLICY CO-SIGNER (factor S)                         [MOCK of an HSM-backed service]
 *
 * One secp256k1 key per client (derived from this service's own seed; an HSM in production).
 * The contract makes it a SECOND factor only: it can never move funds alone.
 *
 * It co-signs:
 *   - vault transfers and dApp calls (with the client's passkey) after: passkey check, sanctions screening,
 *     approved-dApp list, unlimited-approval detection, simulation in plain language, Travel Rule
 *     classification, and a cool-off for large transfers to new recipients ("24 h", 60 s in the demo);
 *   - a passkey replacement (with the card) or a card replacement (with the passkey), only after a signed
 *     video-identification attestation;
 *   - a delayed recovery together with La Poste (both independent checks: video + letter).
 * Alone it can only freeze Face-ID spending (theft hotline).
 */
import { randomUUID } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { erc20Abi, keccak256, toHex, type Address, type Hex } from 'viem';
import {
  Factor,
  NonceLane,
  addFactorSignature,
  api,
  decodeAccountCall,
  decodeFactorSignatures,
  describeIntent,
  deserializeUserOp,
  entryPointAbi,
  formatUsdc,
  getUserOpHash,
  serializeUserOp,
  shortAddress,
  accountCall,
  verifyEcdsaFactor,
  verifyWebAuthnFactor,
  type DecodedCall,
  type NameBook,
  type PackedUserOp,
  type SerializedUserOp,
} from '@rutli/sdk';
import { POSTE_PARTNER_KEY, SERVICE_URLS, SWISSQUOTE_INTERNAL_KEY, loadDeployment } from '../common/config';
import { publicClient, readAccount } from '../common/chain';
import { HttpError, bearer, createApp, requireInternal, start } from '../common/http';
import { deriveClientAccount, ensureKeys } from '../common/keys';
import { knownVasp, screen } from '../common/sanctions';
import { JsonStore } from '../common/store';

const SERVICE = 'sq-cosigner' as const;
const d = loadDeployment();
const keys = await ensureKeys(SERVICE);
const pc = publicClient(d);
const EP = d.contracts.entryPoint;
const HOLD_SECONDS = d.params.holdSeconds;
const HOLD_THRESHOLD = BigInt(d.params.holdThresholdUsdc);
const internal = { 'x-sq-internal-key': SWISSQUOTE_INTERNAL_KEY };
const partner = { 'x-partner-key': POSTE_PARTNER_KEY };
const identJwks = createRemoteJWKSet(new URL(`${SERVICE_URLS.videoIdent}/.well-known/jwks.json`));

/** Swissquote's approved dApp list (published to clients; curated by Compliance). */
const APPROVED_DAPPS = [
  {
    address: d.contracts.vault,
    name: 'Helvetia Yield Vault',
    category: 'Tokenized money-market fund (demo ERC-4626)',
    risk: 'low',
  },
];
const isApproved = (a: string) => APPROVED_DAPPS.find((x) => x.address.toLowerCase() === a.toLowerCase());

type CheckStatus = 'pass' | 'info' | 'warn' | 'hold' | 'fail';
interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}
interface ClientRec {
  index: number;
  cosigner: Address;
  account?: Address;
  addressBook: string[];
  theftReportedAt?: number;
}
interface Hold {
  id: string;
  clientId: string;
  account: Address;
  op: SerializedUserOp;
  userOpHash: Hex;
  summary: string[];
  reasons: string[];
  createdAt: number;
  releaseAt: number;
  status: 'held' | 'executed' | 'cancelled' | 'failed';
  txHash?: Hex;
  error?: string;
}
interface Decision {
  id: string;
  at: number;
  clientId: string;
  kind: string;
  decision: 'approved' | 'held' | 'refused';
  summary: string[];
  checks: Check[];
  txHash?: Hex;
}
interface GuardianCase {
  id: string;
  clientId: string;
  account: Address;
  newPasskeyX: Hex;
  newPasskeyY: Hex;
  newCard: Address;
  reason: string;
  posteCaseId: string;
  posteCaseRef: string;
  letterSentTo: string;
  status: 'awaiting_letter_code' | 'submitted' | 'failed';
  createdAt: number;
  txHash?: Hex;
  executeAfter?: number;
}

const db = new JsonStore(SERVICE, 'db', () => ({
  nextIndex: 0,
  clients: {} as Record<string, ClientRec>,
  holds: {} as Record<string, Hold>,
  decisions: [] as Decision[],
  guardianCases: {} as Record<string, GuardianCase>,
  usedIdentTokens: [] as string[],
}));

// ── helpers ───────────────────────────────────────────────────────────────────────────

function clientKey(clientId: string) {
  const c = db.data.clients[clientId];
  if (!c) throw new HttpError(404, 'unknown client');
  return deriveClientAccount(keys.seedMnemonic, c.index);
}

async function whoami(req: Parameters<typeof bearer>[0]): Promise<{ clientId: string; rec: ClientRec }> {
  const token = bearer(req);
  const s = await api<{ clientId: string }>(`${SERVICE_URLS.sqCore}/internal/session/${token}`, { headers: internal }).catch(
    () => {
      throw new HttpError(401, 'session expired');
    },
  );
  const rec = db.data.clients[s.clientId];
  if (!rec?.account) throw new HttpError(409, 'no wallet registered for this client');
  return { clientId: s.clientId, rec };
}

function nameBook(rec?: ClientRec): NameBook {
  const names: Record<string, string> = {
    [d.contracts.usdc.toLowerCase()]: 'USDC',
    [d.contracts.vault.toLowerCase()]: 'Helvetia Yield Vault',
    [d.addresses.omnibus.toLowerCase()]: 'your Swissquote account',
  };
  if (rec?.account) names[rec.account.toLowerCase()] = 'your wallet';
  return { usdc: d.contracts.usdc, names };
}

async function notifyClient(clientId: string, n: { level: string; title: string; body: string; channels?: string[] }) {
  await api(`${SERVICE_URLS.sqCore}/internal/notify`, { headers: internal, body: { clientId, ...n } }).catch(() => undefined);
}

async function verifyIdent(token: string | undefined, clientId: string, purpose: string) {
  if (!token) throw new HttpError(403, 'Video identification required');
  try {
    const { payload } = await jwtVerify(token, identJwks, { issuer: 'video-ident.mock', subject: clientId });
    if (payload.purpose !== purpose || payload.result !== 'approved') throw new Error('wrong purpose');
    if (db.data.usedIdentTokens.includes(String(payload.jti))) throw new Error('attestation already used');
    db.update((s) => s.usedIdentTokens.push(String(payload.jti)));
  } catch (e) {
    throw new HttpError(403, `Video identification not valid: ${(e as Error).message}`);
  }
}

/** Sponsor, sign with the given factors, and submit through the gas station. */
async function submit(op: PackedUserOp): Promise<{ txHash: Hex; success: boolean; error?: string }> {
  const r = await api<{ txHash: Hex; success: boolean; error?: string }>(`${SERVICE_URLS.gasStation}/send`, {
    body: { op: serializeUserOp(op) },
  });
  return r;
}

async function prepare(account: Address, callData: Hex, lane: bigint): Promise<{ op: PackedUserOp; hash: Hex }> {
  const seq = await pc.readContract({ address: EP, abi: entryPointAbi, functionName: 'getNonce', args: [account, lane] });
  const unsigned: SerializedUserOp = serializeUserOp({
    sender: account,
    nonce: seq, // getNonce returns the full nonce (key << 64 | sequence)
    initCode: '0x',
    callData,
    accountGasLimits: '0x',
    preVerificationGas: 0n,
    gasFees: '0x',
    paymasterAndData: '0x',
    signature: '0x',
  });
  const r = await api<{ op: SerializedUserOp; userOpHash: Hex }>(`${SERVICE_URLS.gasStation}/sponsor`, {
    body: { op: unsigned, purpose: 'security' },
  });
  return { op: deserializeUserOp(r.op), hash: r.userOpHash };
}

async function signAsCosigner(clientId: string, op: PackedUserOp): Promise<PackedUserOp> {
  const hash = getUserOpHash(op, EP, d.chainId);
  const data = await clientKey(clientId).sign({ hash });
  return { ...op, signature: addFactorSignature(op.signature, { factor: Factor.COSIGNER, data }) };
}

function factorData(op: PackedUserOp, factor: number): Hex | undefined {
  if (op.signature === '0x') return undefined;
  try {
    return decodeFactorSignatures(op.signature).find((f) => f.factor === factor)?.data;
  } catch {
    return undefined;
  }
}

// ── simulation ────────────────────────────────────────────────────────────────────────

const TRANSFER_TOPIC = keccak256(toHex('Transfer(address,address,uint256)'));
const APPROVAL_TOPIC = keccak256(toHex('Approval(address,address,uint256)'));
const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
async function meta(token: Address) {
  const k = token.toLowerCase();
  if (k === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return { symbol: 'ETH', decimals: 18 };
  if (!tokenMeta.has(k)) {
    try {
      const [symbol, decimals] = await Promise.all([
        pc.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
        pc.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
      ]);
      tokenMeta.set(k, { symbol, decimals });
    } catch {
      tokenMeta.set(k, { symbol: shortAddress(token), decimals: 18 });
    }
  }
  return tokenMeta.get(k)!;
}
const fmt = (v: bigint, decimals: number) => {
  const s = (Number(v) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: decimals === 6 ? 2 : 4 });
  return s.replace(/,/g, "'");
};

/** Run the operation's call against the current chain state (eth_simulateV1) and list asset changes. */
async function simulate(op: PackedUserOp, book: NameBook): Promise<{ ok: boolean; lines: string[]; error?: string }> {
  try {
    const result = (await pc.request({
      method: 'eth_simulateV1' as never,
      params: [
        { blockStateCalls: [{ calls: [{ from: EP, to: op.sender, data: op.callData }] }], traceTransfers: true },
        'latest',
      ] as never,
    })) as Array<{ calls: Array<{ status: Hex; logs: Array<{ address: Address; topics: Hex[]; data: Hex }>; error?: { message?: string } }> }>;
    const call = result[0]!.calls[0]!;
    if (BigInt(call.status) !== 1n) return { ok: false, lines: [], error: call.error?.message ?? 'reverted' };
    const me = op.sender.toLowerCase();
    const lines: string[] = [];
    for (const log of call.logs ?? []) {
      if (log.topics[0] === TRANSFER_TOPIC && log.topics.length === 3) {
        const from = `0x${log.topics[1]!.slice(26)}`.toLowerCase();
        const to = `0x${log.topics[2]!.slice(26)}` as Address;
        const value = BigInt(log.data);
        const m = await meta(log.address);
        if (from === me) lines.push(`You send ${fmt(value, m.decimals)} ${m.symbol} → ${book.names?.[to.toLowerCase()] ?? shortAddress(to)}`);
        else if (to.toLowerCase() === me) lines.push(`You receive ${fmt(value, m.decimals)} ${m.symbol}`);
      } else if (log.topics[0] === APPROVAL_TOPIC && log.topics.length === 3) {
        const owner = `0x${log.topics[1]!.slice(26)}`.toLowerCase();
        const spender = `0x${log.topics[2]!.slice(26)}` as Address;
        const value = BigInt(log.data);
        if (owner === me && value > 0n) {
          const m = await meta(log.address);
          const unlimited = value > 10n ** 40n;
          lines.push(
            `${book.names?.[spender.toLowerCase()] ?? shortAddress(spender)} may take ${unlimited ? 'ALL your' : fmt(value, m.decimals)} ${m.symbol}${unlimited ? ' (unlimited)' : ''}`,
          );
        }
      }
    }
    return { ok: true, lines: lines.length ? lines : ['No asset leaves your wallet'] };
  } catch (e) {
    return { ok: false, lines: [], error: (e as Error).message.split('\n')[0] };
  }
}

// ── policy engine ─────────────────────────────────────────────────────────────────────

async function analyzeCall(rec: ClientRec, call: DecodedCall, checks: Check[], holdReasons: string[]) {
  const t = screen(call.target);
  if (t.hit) checks.push({ id: 'sanctions', label: 'Sanctions screening', status: 'fail', detail: `${t.list}: ${t.entity}` });

  if (call.erc20) {
    if (call.target.toLowerCase() !== d.contracts.usdc.toLowerCase()) {
      checks.push({ id: 'token', label: 'Token', status: 'warn', detail: `Unlisted token ${shortAddress(call.target)}` });
    }
    if (call.erc20.kind === 'transfer') {
      const to = call.erc20.to;
      const hit = screen(to);
      if (hit.hit) {
        checks.push({ id: 'sanctions', label: 'Sanctions screening', status: 'fail', detail: `Recipient: ${hit.list} — ${hit.entity}` });
        return;
      }
      checks.push({ id: 'sanctions', label: 'Sanctions screening (OFAC, SECO)', status: 'pass', detail: 'No match' });
      const vasp = knownVasp(to);
      if (to.toLowerCase() === d.addresses.omnibus.toLowerCase()) {
        checks.push({ id: 'travel', label: 'Travel Rule', status: 'pass', detail: 'Back to your own Swissquote account (origin verified)' });
      } else if (vasp) {
        checks.push({
          id: 'travel',
          label: 'Travel Rule',
          status: 'info',
          detail: `Recipient is a regulated institution (${vasp.name}): originator data (IVMS101) is sent over TRP (mock)`,
        });
      } else {
        checks.push({
          id: 'travel',
          label: 'Travel Rule',
          status: 'info',
          detail: 'Payment from your self-hosted wallet: you are the sender, Swissquote is not the ordering institution',
        });
      }
      const known = rec.addressBook.includes(to.toLowerCase()) || to.toLowerCase() === d.addresses.omnibus.toLowerCase();
      if (!known && call.erc20.amount >= HOLD_THRESHOLD) {
        holdReasons.push(
          `First transfer of ${formatUsdc(call.erc20.amount)} USDC to a new recipient: ${HOLD_SECONDS}s cool-off (24 h in production), cancellable, with alerts on all channels`,
        );
      } else {
        checks.push({ id: 'recipient', label: 'Recipient', status: known ? 'pass' : 'warn', detail: known ? 'Known recipient' : 'New recipient (below the cool-off threshold)' });
      }
    } else if (call.erc20.kind === 'approve') {
      const dapp = isApproved(call.erc20.spender);
      if (call.erc20.unlimited) {
        checks.push({ id: 'approval', label: 'Approval', status: 'fail', detail: 'UNLIMITED approval: the classic wallet-drainer pattern. Approve an exact amount instead.' });
      } else if (!dapp) {
        checks.push({ id: 'approval', label: 'Approval', status: 'fail', detail: `Approval to ${shortAddress(call.erc20.spender)}, which is not on Swissquote's approved dApp list` });
      } else {
        checks.push({ id: 'approval', label: 'Approval', status: 'pass', detail: `Exact approval to ${dapp.name}` });
      }
    } else {
      checks.push({ id: 'transferFrom', label: 'Token pull', status: 'fail', detail: 'transferFrom from the wallet is not supported' });
    }
    return;
  }

  const dapp = isApproved(call.target);
  if (dapp) {
    checks.push({ id: 'dapp', label: 'dApp', status: 'pass', detail: `${dapp.name} — on Swissquote's approved list (${dapp.category})` });
    return;
  }
  const code = await pc.getCode({ address: call.target });
  if (code && code !== '0x') {
    checks.push({ id: 'dapp', label: 'dApp', status: 'fail', detail: `Contract ${shortAddress(call.target)} is not on Swissquote's approved dApp list` });
  } else if (call.value > 0n) {
    checks.push({ id: 'recipient', label: 'ETH transfer', status: 'warn', detail: `Native ETH to ${shortAddress(call.target)}` });
  }
}

async function analyze(rec: ClientRec, op: PackedUserOp, opts: { released?: boolean } = {}) {
  const intent = decodeAccountCall(op.callData);
  const book = nameBook(rec);
  const summary = describeIntent(intent, book);
  const checks: Check[] = [];
  const holdReasons: string[] = [];

  if (!rec.account || rec.account.toLowerCase() !== op.sender.toLowerCase()) {
    checks.push({ id: 'owner', label: 'Wallet', status: 'fail', detail: 'This wallet does not belong to you' });
  }
  if (rec.theftReportedAt) {
    checks.push({
      id: 'theft',
      label: 'Theft report',
      status: 'fail',
      detail: 'This phone was reported stolen: Swissquote co-signs nothing until the passkey is replaced',
    });
  }
  if (intent.kind !== 'calls') {
    checks.push({ id: 'kind', label: 'Operation', status: 'fail', detail: 'Only transfers and dApp calls are co-signed here' });
  } else {
    for (const call of intent.calls) await analyzeCall(rec, call, checks, holdReasons);
    if (intent.calls.length > 1 && intent.calls.some((c) => c.erc20?.kind === 'approve' && c.erc20.unlimited)) {
      checks.push({ id: 'pattern', label: 'Pattern', status: 'fail', detail: 'Unlimited approval followed by a contract call: wallet drainer' });
    }
  }

  const sim = await simulate(op, book);
  if (!sim.ok) {
    checks.push({ id: 'simulation', label: 'Simulation', status: 'fail', detail: `Would fail: ${sim.error}` });
  } else {
    // The simulation itself is a check: a wallet-wide approval is a red flag whatever the target claims to be.
    const drains = sim.lines.some((l) => l.includes('ALL your'));
    checks.push({
      id: 'simulation',
      label: 'Simulation',
      status: drains ? 'fail' : 'pass',
      detail: drains ? `${sim.lines.join('; ')}. After this, that contract can empty your wallet at any time.` : sim.lines.join('; '),
    });
  }

  let decision: Decision['decision'] = 'approved';
  if (checks.some((c) => c.status === 'fail')) decision = 'refused';
  else if (holdReasons.length && !opts.released) {
    decision = 'held';
    for (const r of holdReasons) checks.push({ id: 'cooloff', label: 'Cool-off', status: 'hold', detail: r });
  }
  return { intent, summary, checks, simulation: sim, decision, holdReasons };
}

function record(clientId: string, kind: string, a: { decision: Decision['decision']; summary: string[]; checks: Check[] }, txHash?: Hex) {
  db.update((s) => {
    s.decisions.unshift({ id: randomUUID(), at: Date.now(), clientId, kind, decision: a.decision, summary: a.summary, checks: a.checks, txHash });
    s.decisions = s.decisions.slice(0, 200);
  });
}

// ── API ───────────────────────────────────────────────────────────────────────────────

const app = createApp(SERVICE);

app.post('/internal/clients/:clientId/key', (req, res) => {
  requireInternal(req);
  const id = req.params.clientId!;
  let rec = db.data.clients[id];
  if (!rec) {
    const index = db.data.nextIndex;
    rec = { index, cosigner: deriveClientAccount(keys.seedMnemonic, index).address, addressBook: [] };
    db.update((s) => {
      s.nextIndex++;
      s.clients[id] = rec!;
    });
  }
  res.json({ cosigner: rec.cosigner });
});

app.post('/internal/clients/:clientId/account', (req, res) => {
  requireInternal(req);
  const rec = db.data.clients[req.params.clientId!];
  if (!rec) throw new HttpError(404, 'unknown client');
  db.update(() => (rec.account = req.body?.account));
  res.json({ ok: true });
});

app.get('/policy', (_req, res) => {
  res.json({
    approvedDapps: APPROVED_DAPPS,
    holdSeconds: HOLD_SECONDS,
    holdThresholdUsdc: HOLD_THRESHOLD.toString(),
    screening: 'OFAC SDN + SECO (mock provider)',
  });
});

/** Dry run: what Swissquote would do, shown to the client BEFORE Face ID. */
app.post('/preview', async (req, res) => {
  const { clientId, rec } = await whoami(req);
  const op = deserializeUserOp(req.body?.op);
  const a = await analyze(rec, op);
  res.json({ clientId, summary: a.summary, checks: a.checks, decision: a.decision, holdSeconds: a.decision === 'held' ? HOLD_SECONDS : 0 });
});

/** Co-sign a vault operation already signed by the client's passkey. */
app.post('/cosign', async (req, res) => {
  const { clientId, rec } = await whoami(req);
  const op = deserializeUserOp(req.body?.op);
  const hash = getUserOpHash(op, EP, d.chainId);

  // The client's own factor must be there and valid: the co-signer is never a signing oracle.
  const onchain = await readAccount(pc, op.sender);
  const p = factorData(op, Factor.PASSKEY);
  if (!onchain || !p || !verifyWebAuthnFactor(hash, p, onchain.passkeyX, onchain.passkeyY)) {
    throw new HttpError(403, 'Missing or invalid passkey signature');
  }

  const a = await analyze(rec, op);
  if (a.decision === 'refused') {
    record(clientId, a.intent.kind, a);
    res.status(403).json({ error: 'Swissquote refuses to co-sign', decision: 'refused', summary: a.summary, checks: a.checks });
    return;
  }
  if (a.decision === 'held') {
    const hold: Hold = {
      id: randomUUID(),
      clientId,
      account: op.sender,
      op: serializeUserOp(op),
      userOpHash: hash,
      summary: a.summary,
      reasons: a.holdReasons,
      createdAt: Date.now(),
      releaseAt: Date.now() + HOLD_SECONDS * 1000,
      status: 'held',
    };
    db.update((s) => (s.holds[hold.id] = hold));
    record(clientId, a.intent.kind, a);
    await notifyClient(clientId, {
      level: 'warning',
      title: 'Large transfer to a new recipient scheduled',
      body: `${a.summary.join('; ')}. It will execute in ${HOLD_SECONDS}s (24 h in production) unless you cancel it.`,
      channels: ['app', 'email', 'sms'],
    });
    res.status(202).json({ decision: 'held', holdId: hold.id, releaseAt: hold.releaseAt, summary: a.summary, checks: a.checks });
    return;
  }
  const signed = await signAsCosigner(clientId, op);
  const r = await submit(signed);
  record(clientId, a.intent.kind, a, r.txHash);
  if (r.success) rememberRecipients(rec, a.intent);
  res.json({ decision: 'approved', ...r, summary: a.summary, checks: a.checks });
});

function rememberRecipients(rec: ClientRec, intent: ReturnType<typeof decodeAccountCall>) {
  if (intent.kind !== 'calls') return;
  db.update(() => {
    for (const c of intent.calls) {
      const to = c.erc20?.kind === 'transfer' ? c.erc20.to.toLowerCase() : undefined;
      if (to && !rec.addressBook.includes(to)) rec.addressBook.push(to);
    }
  });
}

app.get('/holds', async (req, res) => {
  const { clientId } = await whoami(req);
  res.json(Object.values(db.data.holds).filter((h) => h.clientId === clientId).sort((a, b) => b.createdAt - a.createdAt));
});

app.delete('/holds/:id', async (req, res) => {
  const { clientId } = await whoami(req);
  const h = db.data.holds[req.params.id!];
  if (!h || h.clientId !== clientId) throw new HttpError(404, 'hold not found');
  if (h.status !== 'held') throw new HttpError(409, `already ${h.status}`);
  db.update(() => (h.status = 'cancelled'));
  res.json({ status: h.status });
});

/** Release matured holds (re-checked at release time). */
async function releaseHolds() {
  for (const h of Object.values(db.data.holds)) {
    if (h.status !== 'held' || h.releaseAt > Date.now()) continue;
    const rec = db.data.clients[h.clientId]!;
    try {
      const op = deserializeUserOp(h.op);
      const a = await analyze(rec, op, { released: true });
      if (a.decision !== 'approved') {
        db.update(() => {
          h.status = 'cancelled';
          h.error = a.checks.filter((c) => c.status === 'fail').map((c) => c.detail).join('; ');
        });
        continue;
      }
      const r = await submit(await signAsCosigner(h.clientId, op));
      db.update(() => {
        h.status = r.success ? 'executed' : 'failed';
        h.txHash = r.txHash;
        h.error = r.error;
      });
      if (r.success) rememberRecipients(rec, a.intent);
      await notifyClient(h.clientId, {
        level: r.success ? 'success' : 'danger',
        title: r.success ? 'Scheduled transfer executed' : 'Scheduled transfer failed',
        body: h.summary.join('; '),
      });
    } catch (e) {
      db.update(() => {
        h.status = 'failed';
        h.error = (e as Error).message;
      });
    }
  }
}
setInterval(() => void releaseHolds(), 3000);

/** Theft hotline (via core banking): freeze Face-ID spending — the only thing Swissquote can do alone. */
app.post('/internal/theft-report', async (req, res) => {
  requireInternal(req);
  const clientId = String(req.body?.clientId);
  const rec = db.data.clients[clientId];
  if (!rec?.account) throw new HttpError(404, 'no wallet');
  db.update((s) => {
    rec.theftReportedAt = Date.now();
    for (const h of Object.values(s.holds)) if (h.clientId === clientId && h.status === 'held') h.status = 'cancelled';
  });
  const { op } = await prepare(rec.account, accountCall.freeze(), NonceLane.SECURITY);
  const r = await submit(await signAsCosigner(clientId, op));
  const st = await readAccount(pc, rec.account);
  res.json({ ...r, frozenUntil: st?.frozenUntil });
});

/** Lost phone: new passkey signed by the CARD + video identification → Swissquote co-signs. */
app.post('/recovery/rotate-passkey', async (req, res) => {
  const { clientId, rec } = await whoami(req);
  await verifyIdent(req.body?.identToken, clientId, 'rotate-passkey');
  const op = deserializeUserOp(req.body?.op);
  const intent = decodeAccountCall(op.callData);
  if (intent.kind !== 'rotatePasskey' || op.sender.toLowerCase() !== rec.account!.toLowerCase()) {
    throw new HttpError(400, 'Expected a passkey replacement for your wallet');
  }
  const onchain = (await readAccount(pc, op.sender))!;
  const hash = getUserOpHash(op, EP, d.chainId);
  const c = factorData(op, Factor.CARD);
  if (!c || !(await verifyEcdsaFactor(hash, c, onchain.card))) throw new HttpError(403, 'Recovery card signature invalid');
  const r = await submit(await signAsCosigner(clientId, op));
  if (r.success) {
    db.update(() => (rec.theftReportedAt = undefined));
    await notifyClient(clientId, {
      level: 'success',
      title: 'Passkey replaced',
      body: 'Your new phone now controls the wallet. The old phone can no longer sign anything.',
      channels: ['app', 'email', 'sms'],
    });
  }
  res.json(r);
});

/** Lost card: new card address signed by the PASSKEY + video identification → Swissquote co-signs. */
app.post('/recovery/rotate-card', async (req, res) => {
  const { clientId, rec } = await whoami(req);
  if (rec.theftReportedAt) throw new HttpError(403, 'Phone reported stolen: replace the passkey first');
  await verifyIdent(req.body?.identToken, clientId, 'rotate-card');
  const op = deserializeUserOp(req.body?.op);
  const intent = decodeAccountCall(op.callData);
  if (intent.kind !== 'rotateCard' || op.sender.toLowerCase() !== rec.account!.toLowerCase()) {
    throw new HttpError(400, 'Expected a card replacement for your wallet');
  }
  const onchain = (await readAccount(pc, op.sender))!;
  const hash = getUserOpHash(op, EP, d.chainId);
  const p = factorData(op, Factor.PASSKEY);
  if (!p || !verifyWebAuthnFactor(hash, p, onchain.passkeyX, onchain.passkeyY)) throw new HttpError(403, 'Passkey signature invalid');
  const r = await submit(await signAsCosigner(clientId, op));
  if (r.success) {
    await notifyClient(clientId, { level: 'success', title: 'Recovery card replaced', body: 'Your previous card is now void.', channels: ['app', 'email'] });
  }
  res.json(r);
});

/** Lost everything: video identification (Swissquote) + letter code (La Poste) → delayed recovery. */
app.post('/recovery/guardian/start', async (req, res) => {
  const { clientId, rec } = await whoami(req);
  const { newPasskeyX, newPasskeyY, newCard, identToken } = req.body ?? {};
  const reason = req.body?.reason === 'INHERITANCE' ? 'INHERITANCE' : 'LOST_ALL';
  await verifyIdent(identToken, clientId, 'guardian-recovery');
  const r = await api<{ caseId: string; caseRef: string; letterSentTo: string }>(`${SERVICE_URLS.poste}/cases`, {
    headers: partner,
    body: { clientId, account: rec.account, newPasskeyX, newPasskeyY, newCard, reason },
  });
  const kase: GuardianCase = {
    id: randomUUID(),
    clientId,
    account: rec.account!,
    newPasskeyX,
    newPasskeyY,
    newCard,
    reason,
    posteCaseId: r.caseId,
    posteCaseRef: r.caseRef,
    letterSentTo: r.letterSentTo,
    status: 'awaiting_letter_code',
    createdAt: Date.now(),
  };
  db.update((s) => (s.guardianCases[kase.id] = kase));
  res.json({ caseId: kase.id, posteCaseId: r.caseId, caseRef: r.caseRef, letterSentTo: r.letterSentTo });
});

app.post('/recovery/guardian/:id/submit', async (req, res) => {
  const { clientId } = await whoami(req);
  const kase = db.data.guardianCases[req.params.id!];
  if (!kase || kase.clientId !== clientId) throw new HttpError(404, 'case not found');
  if (kase.status === 'submitted') {
    res.json({ status: kase.status, txHash: kase.txHash, executeAfter: kase.executeAfter });
    return;
  }
  const reasonHash = keccak256(toHex(`${kase.reason}:${kase.id}`));
  const { op } = await prepare(
    kase.account,
    accountCall.initiateRecovery(kase.newPasskeyX, kase.newPasskeyY, kase.newCard, reasonHash),
    NonceLane.SECURITY,
  );
  const sOp = await signAsCosigner(clientId, op);
  const g = await api<{ factor: number; data: Hex }>(`${SERVICE_URLS.poste}/cases/${kase.posteCaseId}/sign`, {
    headers: partner,
    body: { op: serializeUserOp(op) },
  });
  const full = { ...sOp, signature: addFactorSignature(sOp.signature, { factor: Factor.GUARDIAN, data: g.data }) };
  const r = await submit(full);
  if (!r.success) throw new HttpError(500, r.error ?? 'recovery failed');
  const st = await readAccount(pc, kase.account);
  db.update(() => {
    kase.status = 'submitted';
    kase.txHash = r.txHash;
    kase.executeAfter = st?.pendingRecovery.executeAfter;
  });
  await notifyClient(clientId, {
    level: 'danger',
    title: 'A recovery of your wallet has started',
    body: `Swissquote and La Poste confirmed it (video + letter). It completes in ${d.params.recoveryDelay}s (7 days in production). Not you? Cancel with Face ID or your card.`,
    channels: ['app (all devices)', 'email', 'sms', 'trusted contact', 'letter'],
  });
  res.json({ status: kase.status, txHash: r.txHash, executeAfter: kase.executeAfter });
});

app.get('/recovery/guardian/:id', async (req, res) => {
  const { clientId } = await whoami(req);
  const kase = db.data.guardianCases[req.params.id!];
  if (!kase || kase.clientId !== clientId) throw new HttpError(404, 'case not found');
  res.json(kase);
});

/** Back-office view (demo). */
app.get('/ops/overview', (_req, res) => {
  res.json({
    clients: Object.entries(db.data.clients).map(([id, c]) => ({ id, ...c })),
    holds: Object.values(db.data.holds).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30),
    decisions: db.data.decisions.slice(0, 30),
    guardianCases: Object.values(db.data.guardianCases).sort((a, b) => b.createdAt - a.createdAt),
  });
});

start(app, SERVICE, 'Swissquote policy co-signer');
