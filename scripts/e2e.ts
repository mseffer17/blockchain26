/**
 * The whole story, end to end, against the running stack (chain + 6 services), through the same HTTP APIs
 * the app uses. Passkeys are software authenticators producing real WebAuthn assertions.
 *
 *   npm run dev -- --no-app      (in another terminal)
 *   npm run e2e
 *
 * create → Travel-Rule-verified funding → gasless Face-ID payment → co-signed vault transfer → cool-off →
 * approved dApp vs drainer → sanctions → THEFT (thief limited, refused by video-ident and by La Poste) →
 * hotline freeze → new phone with card → lost everything (video + letter) → client cancels collusion →
 * delayed recovery → SWISSQUOTE GONE: exit with the paper card only.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  maxUint256,
  parseEther,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import {
  Factor,
  NonceLane,
  SoftPasskey,
  accountCall,
  api,
  ApiError,
  cardAccount,
  cardSign,
  chainFromDeployment,
  deserializeUserOp,
  encodeFactorSignatures,
  entryPointAbi,
  formatUsdc,
  getUserOpHash,
  helvetiaYieldVaultAbi,
  ownershipChallenge,
  rutliAccountAbi,
  rutliFactoryAbi,
  scamAirdropAbi,
  serializeUserOp,
  type Deployment,
  type FactorSignature,
  type SerializedUserOp,
} from '@rutli/sdk';
import { generateCardMnemonic } from '@rutli/sdk';

const sqCoreUrl = process.env.SQ_CORE_URL ?? 'http://localhost:4000';
const d = await api<Deployment>(`${sqCoreUrl}/config`);
const S = d.services;
const chain = chainFromDeployment(d);
const pc: PublicClient = createPublicClient({ chain, transport: http(d.rpcUrl) });

let step = 0;
const title = (s: string) => console.log(`\n\x1b[1m\x1b[36m${++step}. ${s}\x1b[0m`);
const ok = (s: string) => console.log(`   \x1b[32m✔\x1b[0m ${s}`);
const info = (s: string) => console.log(`   \x1b[90m${s}\x1b[0m`);
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(`   \x1b[31m✘ ${msg}\x1b[0m`);
    process.exit(1);
  }
}
async function expectError(p: Promise<unknown>, status: number, label: string): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError && e.status === status) {
      ok(`${label} → refused (${status}): ${e.message}`);
      return e;
    }
    throw e;
  }
  console.error(`   \x1b[31m✘ ${label} was NOT refused\x1b[0m`);
  process.exit(1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usdcOf = (a: Address) => pc.readContract({ address: d.contracts.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [a] });
async function timeTravel(seconds: number) {
  await pc.request({ method: 'evm_increaseTime' as never, params: [seconds] as never });
  await pc.request({ method: 'evm_mine' as never, params: [] as never });
}

/** Build → sponsor (gas station) → sign with factors → return op. */
async function buildOp(account: Address, callData: Hex, lane: bigint, purpose = 'default') {
  const nonce = await pc.readContract({ address: d.contracts.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [account, lane] });
  const r = await api<{ op: SerializedUserOp; userOpHash: Hex }>(`${S.gasStation}/sponsor`, {
    body: {
      op: serializeUserOp({ sender: account, nonce, initCode: '0x', callData, accountGasLimits: '0x', preVerificationGas: 0n, gasFees: '0x', paymasterAndData: '0x', signature: '0x' }),
      purpose,
    },
  });
  const op = deserializeUserOp(r.op);
  const local = getUserOpHash(op, d.contracts.entryPoint, d.chainId);
  assert(local === r.userOpHash, 'userOpHash mismatch (sdk vs gas station)');
  return { op, hash: r.userOpHash };
}
async function signed(op: ReturnType<typeof deserializeUserOp>, sigs: FactorSignature[]) {
  return serializeUserOp({ ...op, signature: encodeFactorSignatures(sigs) });
}
const send = (op: SerializedUserOp) => api<{ success: boolean; txHash: Hex; error?: string; gasPaidBySwissquoteWei?: string }>(`${S.gasStation}/send`, { body: { op } });

async function identify(clientId: string, persona: string, purpose: string): Promise<string | undefined> {
  const { sessionId } = await api<{ sessionId: string }>(`${S.videoIdent}/sessions`, { body: { clientId, purpose } });
  await api(`${S.videoIdent}/sessions/${sessionId}/capture`, { body: { persona } });
  for (let i = 0; i < 20; i++) {
    const s = await api<{ status: string; token?: string; reason?: string }>(`${S.videoIdent}/sessions/${sessionId}`);
    if (s.status === 'approved') {
      ok(`video identification (${persona}): approved — ${s.reason}`);
      return s.token;
    }
    if (s.status === 'rejected') {
      ok(`video identification (${persona}): REJECTED — ${s.reason}`);
      return undefined;
    }
    await sleep(500);
  }
  throw new Error('video identification timeout');
}

// ═══════════════════════════════════════════════════════════════════════════════════════
title('Claire logs into Swissquote and creates her Rütli wallet');
const login = (device: string) =>
  api<{ token: string }>(`${sqCoreUrl}/session/login`, { body: { clientId: 'claire', password: 'demo', device } }).then((r) => r.token);
const phone1Token = await login('phone-1');
const prep = await api<{
  cosigner: Address;
  guardian: Address;
  salt: Hex;
  ownershipNonce: Hex;
  recoveryDelay: number;
  exitDelay: number;
  allowanceTokens: Address[];
  allowanceLimits: string[];
}>(`${sqCoreUrl}/wallet/prepare`, { token: phone1Token, body: {} });
info(`Swissquote co-signer key for Claire: ${prep.cosigner}`);
info(`La Poste guardian key for Claire:    ${prep.guardian}`);

const phone1 = SoftPasskey.generate(); // Face ID on Claire's phone
const cardWords = generateCardMnemonic(); // printed recovery card
const card = cardAccount(cardWords);
const cfg = {
  passkeyX: phone1.publicKey.x,
  passkeyY: phone1.publicKey.y,
  card: card.address,
  cosigner: prep.cosigner,
  guardian: prep.guardian,
  recoveryDelay: prep.recoveryDelay,
  exitDelay: prep.exitDelay,
  allowanceTokens: prep.allowanceTokens,
  allowanceLimits: prep.allowanceLimits,
};
const account = await pc.readContract({
  address: d.contracts.factory,
  abi: rutliFactoryAbi,
  functionName: 'getAddress',
  args: [{ ...cfg, allowanceLimits: cfg.allowanceLimits.map(BigInt) }, prep.salt],
});
const proof = phone1.sign(ownershipChallenge({ clientId: 'claire', account, chainId: d.chainId, nonce: prep.ownershipNonce }));
const activated = await api<{ account: Address; txHash: Hex }>(`${sqCoreUrl}/wallet/activate`, { token: phone1Token, body: { cfg, ownershipProof: proof } });
assert(activated.account === account, 'account address');
ok(`wallet deployed at ${account} (gas paid by Swissquote)`);
ok('Travel Rule: ownership verified by the passkey signature bound to the CREATE2 address');

title('Funding from her Swissquote account (instant: ownership already verified)');
await api(`${sqCoreUrl}/transfers/to-wallet`, { token: phone1Token, body: { amount: '5000000000' } });
assert((await usdcOf(account)) === 5_000_000_000n, 'wallet funded');
ok(`wallet balance: ${formatUsdc(await usdcOf(account))} USDC`);
await expectError(
  api(`${sqCoreUrl}/transfers/to-external`, { token: phone1Token, body: { address: privateKeyToAccount(generatePrivateKey()).address, amount: '1000000' } }),
  403,
  'withdrawal to an unverified external wallet (status quo)',
);

title('Gasless payment with Face ID only (porte-monnaie)');
const bob = privateKeyToAccount(generatePrivateKey()).address;
{
  const { op, hash } = await buildOp(account, accountCall.spend(d.contracts.usdc, bob, 20_000_000n), NonceLane.PORTE_MONNAIE);
  const r = await send(await signed(op, [{ factor: Factor.PASSKEY, data: phone1.sign(hash) }]));
  assert(r.success, `spend failed: ${r.error}`);
  assert((await pc.getBalance({ address: account })) === 0n, 'no ETH in the wallet');
  ok(`20 USDC to Bob — the wallet holds 0 ETH; Swissquote paid ${r.gasPaidBySwissquoteWei} wei of gas`);
}

title('Vault transfer: Face ID + Swissquote co-signature');
const usdcTransfer = (to: Address, amount: bigint) =>
  accountCall.execute(d.contracts.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }));
{
  const { op, hash } = await buildOp(account, usdcTransfer(bob, 300_000_000n), NonceLane.COFFRE, 'coffre');
  const preview = await api<{ decision: string; summary: string[] }>(`${S.cosigner}/preview`, { token: phone1Token, body: { op: serializeUserOp(op) } });
  info(`preview: ${preview.summary.join('; ')} → ${preview.decision}`);
  const r = await api<{ decision: string; success: boolean }>(`${S.cosigner}/cosign`, {
    token: phone1Token,
    body: { op: await signed(op, [{ factor: Factor.PASSKEY, data: phone1.sign(hash) }]) },
  });
  assert(r.decision === 'approved' && r.success, 'co-signed transfer');
  ok('300 USDC to Bob: screened, simulated, co-signed, executed');
}

title('Large transfer to a NEW recipient: cool-off');
const charlie = privateKeyToAccount(generatePrivateKey()).address;
let holdId: string;
{
  const { op, hash } = await buildOp(account, usdcTransfer(charlie, 1_000_000_000n), NonceLane.COFFRE, 'coffre');
  const r = await api<{ decision: string; holdId: string; releaseAt: number }>(`${S.cosigner}/cosign`, {
    token: phone1Token,
    body: { op: await signed(op, [{ factor: Factor.PASSKEY, data: phone1.sign(hash) }]) },
  });
  assert(r.decision === 'held', 'should be held');
  holdId = r.holdId;
  ok(`1'000 USDC to a new recipient held for ${d.params.holdSeconds}s (24 h in production), alerts sent`);
  info('waiting for the cool-off to end...');
  for (let i = 0; i < 40; i++) {
    const holds = await api<Array<{ id: string; status: string }>>(`${S.cosigner}/holds`, { token: phone1Token });
    const h = holds.find((x) => x.id === holdId)!;
    if (h.status !== 'held') {
      assert(h.status === 'executed', `hold ended as ${h.status}`);
      break;
    }
    await sleep(3000);
  }
  assert((await usdcOf(charlie)) === 1_000_000_000n, 'held transfer executed');
  ok('cool-off over: transfer executed automatically');
}

title('dApps: approved vault (exact approval) vs wallet drainer');
{
  const calls = [
    { target: d.contracts.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.contracts.vault, 200_000_000n] }) },
    { target: d.contracts.vault, value: 0n, data: encodeFunctionData({ abi: helvetiaYieldVaultAbi, functionName: 'deposit', args: [200_000_000n, account] }) },
  ];
  const { op, hash } = await buildOp(account, accountCall.executeBatch(calls), NonceLane.COFFRE, 'coffre');
  const r = await api<{ decision: string; success: boolean; checks: Array<{ label: string; detail?: string }> }>(`${S.cosigner}/cosign`, {
    token: phone1Token,
    body: { op: await signed(op, [{ factor: Factor.PASSKEY, data: phone1.sign(hash) }]) },
  });
  assert(r.success, 'vault deposit');
  info(r.checks.find((c) => c.label === 'Simulation')?.detail ?? '');
  ok('200 USDC deposited into the approved Helvetia Yield Vault');

  const scamCalls = [
    { target: d.contracts.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [d.contracts.scam, maxUint256] }) },
    { target: d.contracts.scam, value: 0n, data: encodeFunctionData({ abi: scamAirdropAbi, functionName: 'claimAirdrop' }) },
  ];
  const s2 = await buildOp(account, accountCall.executeBatch(scamCalls), NonceLane.COFFRE, 'coffre');
  const e = await expectError(
    api(`${S.cosigner}/cosign`, { token: phone1Token, body: { op: await signed(s2.op, [{ factor: Factor.PASSKEY, data: phone1.sign(s2.hash) }]) } }),
    403,
    '"Free airdrop" drainer',
  );
  for (const c of ((e.body as { checks: Array<{ status: string; label: string; detail?: string }> }).checks ?? []).filter((x) => x.status === 'fail')) {
    info(`✗ ${c.label}: ${c.detail}`);
  }
}

title('Sanctions screening');
await expectError(
  buildOp(account, accountCall.spend(d.contracts.usdc, '0x098B716B8Aaf21512996dC57EB0615e2383E2f96', 1_000_000n), NonceLane.PORTE_MONNAIE),
  403,
  'payment to an OFAC-listed address',
);

// ═══════════════════════════════════════════════════════════════════════════════════════
title('THEFT: Mallory has the phone, the passcode, the e-mail and the banking session');
const mallory = privateKeyToAccount(generatePrivateKey()).address;
{
  const { op, hash } = await buildOp(account, accountCall.spend(d.contracts.usdc, mallory, 900_000_000n), NonceLane.PORTE_MONNAIE);
  const r = await send(await signed(op, [{ factor: Factor.PASSKEY, data: phone1.sign(hash) }]));
  assert(r.success, 'thief spend within allowance');
  ok('she empties the porte-monnaie: 900 USDC (the daily maximum left)');
}
await expectError(
  buildOp(account, accountCall.spend(d.contracts.usdc, mallory, 100_000_000n), NonceLane.PORTE_MONNAIE),
  422,
  'one more Face-ID payment',
);
let thiefHold: string;
{
  const { op, hash } = await buildOp(account, usdcTransfer(mallory, 2_000_000_000n), NonceLane.COFFRE, 'coffre');
  const r = await api<{ decision: string; holdId: string }>(`${S.cosigner}/cosign`, {
    token: phone1Token,
    body: { op: await signed(op, [{ factor: Factor.PASSKEY, data: phone1.sign(hash) }]) },
  });
  assert(r.decision === 'held', 'thief vault transfer held');
  thiefHold = r.holdId;
  ok('2\'000 USDC from the vault to her own address: put on hold, Claire alerted by SMS/e-mail');
}
{
  const token = await identify('claire', 'mallory', 'guardian-recovery');
  assert(!token, 'thief must fail video identification');
  const fake = SoftPasskey.generate();
  await expectError(
    api(`${S.cosigner}/recovery/guardian/start`, {
      token: phone1Token,
      body: { newPasskeyX: fake.publicKey.x, newPasskeyY: fake.publicKey.y, newCard: mallory, identToken: token },
    }),
    403,
    '"I lost everything" recovery by the thief',
  );
}

title('Claire calls the hotline from her husband’s phone: freeze ("blocking is easy")');
{
  const r = await api<{ frozenUntil: number }>(`${sqCoreUrl}/hotline/report-theft`, { body: { clientId: 'claire', birthDate: '1968-04-12' } });
  ok(`Face-ID spending frozen on-chain until ${new Date(r.frozenUntil * 1000).toISOString()}`);
  const holds = await api<Array<{ id: string; status: string }>>(`${S.cosigner}/holds`, { token: phone1Token });
  assert(holds.find((h) => h.id === thiefHold)?.status === 'cancelled', 'thief hold cancelled');
  ok("Mallory's pending vault transfer cancelled");
  await expectError(
    buildOp(account, accountCall.spend(d.contracts.usdc, mallory, 10_000_000n), NonceLane.PORTE_MONNAIE),
    422,
    'Mallory tries another Face-ID payment',
  );
}

title('New phone + recovery card + video identification → passkey replaced');
const phone2 = SoftPasskey.generate();
const phone2Token = await login('phone-2');
{
  const token = await identify('claire', 'claire', 'rotate-passkey');
  const { op, hash } = await buildOp(account, accountCall.rotatePasskey(phone2.publicKey.x, phone2.publicKey.y), NonceLane.SECURITY, 'security');
  const r = await api<{ success: boolean }>(`${S.cosigner}/recovery/rotate-passkey`, {
    token: phone2Token,
    body: { op: await signed(op, [{ factor: Factor.CARD, data: await cardSign(cardWords, hash) }]), identToken: token },
  });
  assert(r.success, 'rotate passkey');
  ok('passkey replaced (card + Swissquote); freeze lifted');
  const { op: o2, hash: h2 } = await buildOp(account, accountCall.spend(d.contracts.usdc, mallory, 1_000_000n), NonceLane.PORTE_MONNAIE);
  await expectError(send(await signed(o2, [{ factor: Factor.PASSKEY, data: phone1.sign(h2) }])), 400, "Mallory's old phone");
  const { op: o3, hash: h3 } = await buildOp(account, accountCall.spend(d.contracts.usdc, bob, 1_000_000n), NonceLane.PORTE_MONNAIE);
  assert((await send(await signed(o3, [{ factor: Factor.PASSKEY, data: phone2.sign(h3) }]))).success, 'new phone works');
  ok('the new phone pays with Face ID');
}

// ═══════════════════════════════════════════════════════════════════════════════════════
title('Lost EVERYTHING (phone and card): Swissquote video-ident + La Poste letter → delayed recovery');
const phone3 = SoftPasskey.generate();
const card2Words = generateCardMnemonic();
const card2 = cardAccount(card2Words);
async function guardianRecovery(token: string) {
  const ident = await identify('claire', 'claire', 'guardian-recovery');
  const start = await api<{ caseId: string; posteCaseId: string; letterSentTo: string }>(`${S.cosigner}/recovery/guardian/start`, {
    token,
    body: { newPasskeyX: phone3.publicKey.x, newPasskeyY: phone3.publicKey.y, newCard: card2.address, identToken: ident },
  });
  ok(`La Poste mailed a registered letter to ${start.letterSentTo}`);
  await expectError(
    api(`${S.cosigner}/recovery/guardian/${start.caseId}/submit`, { token, body: {} }),
    409,
    'submitting before typing the letter code',
  );
  const boxes = await api<Array<{ id: string; owner: string }>>(`${S.poste}/mailboxes`);
  const box = await api<{ letters: Array<{ code: string; caseRef: string }> }>(`${S.poste}/mailboxes/${boxes.find((b) => b.owner === 'Claire Dubois')!.id}`);
  const letter = box.letters[0]!;
  info(`letter in Claire's mailbox: code ${letter.code}`);
  await expectError(api(`${S.poste}/cases/${start.posteCaseId}/verify`, { body: { code: 'WRONG-CODE' } }), 403, 'wrong code');
  await api(`${S.poste}/cases/${start.posteCaseId}/verify`, { body: { code: letter.code } });
  const sub = await api<{ executeAfter: number }>(`${S.cosigner}/recovery/guardian/${start.caseId}/submit`, { token, body: {} });
  ok(`recovery started on-chain (S + G); executes after ${new Date(sub.executeAfter * 1000).toISOString()}`);
  return sub;
}
const phone3Token = await login('phone-3');
await guardianRecovery(phone3Token);

title('Collusion test: Claire (who still has her phone) cancels with one Face ID');
{
  const { op, hash } = await buildOp(account, accountCall.cancelRecovery(), NonceLane.SECURITY, 'security');
  const r = await send(await signed(op, [{ factor: Factor.PASSKEY, data: phone2.sign(hash) }]));
  assert(r.success, 'cancel');
  const pending = await pc.readContract({ address: account, abi: rutliAccountAbi, functionName: 'pendingRecovery' });
  assert(pending.executeAfter === 0n, 'no pending recovery');
  ok('recovery cancelled: Swissquote + La Poste together cannot take the wallet');
}

title('Genuine total loss: the recovery runs its course');
await guardianRecovery(phone3Token);
await timeTravel(d.params.recoveryDelay + 1);
info(`time travel: +${d.params.recoveryDelay}s (7 days in production); the watchtower finalizes it`);
for (let i = 0; i < 20; i++) {
  const [x] = await pc.readContract({ address: account, abi: rutliAccountAbi, functionName: 'passkey' });
  if (x === phone3.publicKey.x) break;
  await sleep(1000);
}
{
  const [x] = await pc.readContract({ address: account, abi: rutliAccountAbi, functionName: 'passkey' });
  assert(x === phone3.publicKey.x, 'recovery finalized');
  assert((await pc.readContract({ address: account, abi: rutliAccountAbi, functionName: 'card' })) === card2.address, 'new card');
  ok('new passkey and new card installed; funds untouched');
}

// ═══════════════════════════════════════════════════════════════════════════════════════
title('SWISSQUOTE IS GONE: exit with the paper card only (public RPC, no Swissquote server)');
{
  const cardWallet = createWalletClient({ chain, transport: http(d.rpcUrl), account: card2 });
  await pc.request({ method: 'anvil_setBalance' as never, params: [card2.address, `0x${parseEther('0.01').toString(16)}`] as never });
  info('the card address needs a few cents of ETH for gas (any exchange or friend can send it)');
  let hash = await cardWallet.writeContract({ address: account, abi: rutliAccountAbi, functionName: 'initiateExit' });
  await pc.waitForTransactionReceipt({ hash });
  ok('initiateExit() sent directly by the card');
  await timeTravel(d.params.exitDelay + 1);
  info(`time travel: +${d.params.exitDelay}s (30 days in production)`);
  hash = await cardWallet.writeContract({ address: account, abi: rutliAccountAbi, functionName: 'finalizeExit' });
  await pc.waitForTransactionReceipt({ hash });
  assert(await pc.readContract({ address: account, abi: rutliAccountAbi, functionName: 'sovereign' }), 'sovereign');
  ok('sovereign mode: Swissquote and La Poste removed, the card has full control');
  const newHome = privateKeyToAccount(generatePrivateKey()).address;
  const balance = await usdcOf(account);
  hash = await cardWallet.writeContract({
    address: account,
    abi: rutliAccountAbi,
    functionName: 'execute',
    args: [d.contracts.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [newHome, balance] })],
  });
  await pc.waitForTransactionReceipt({ hash });
  assert((await usdcOf(newHome)) === balance, 'swept');
  ok(`${formatUsdc(balance)} USDC swept to a wallet of her choice`);
}

console.log('\n\x1b[1m\x1b[32m✔ The whole story works end to end.\x1b[0m');
console.log(`   Thief's total take: ${formatUsdc(await usdcOf(mallory))} USDC (the porte-monnaie's daily limit).`);
process.exit(0);
