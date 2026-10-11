/**
 * SWISSQUOTE CORE BANKING                                                                 [MOCK]
 *
 * Stands in for Swissquote's banking platform: client accounts and KYC, custodial balances held in an
 * omnibus wallet, the Travel Rule registry of verified self-hosted wallets, notifications, the theft
 * hotline, and the issuer of portable wallet-ownership credentials (SD-JWT VC).
 *
 * What is real: the on-chain transfers between the omnibus wallet and the client's wallet (USDC on the
 * configured chain), the cryptographic ownership proof (WebAuthn passkey signature checked against the
 * key the wallet address commits to), and the SD-JWT signatures.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, importJWK, jwtVerify, type JWK } from 'jose';
import { erc20Abi, getAddress, keccak256, parseEventLogs, toHex, type Address, type Hex } from 'viem';
import {
  OWNERSHIP_PROOF_TAG,
  api,
  formatUsdc,
  ownershipChallenge,
  rutliFactoryAbi,
  verifyWebAuthnFactor,
} from '@rutli/sdk';
import { POSTE_PARTNER_KEY, SERVICE_URLS, SWISSQUOTE_INTERNAL_KEY, loadDeployment } from '../common/config';
import { publicClient, walletClient } from '../common/chain';
import { HttpError, bearer, createApp, requireInternal, start } from '../common/http';
import { accountOf, ensureKeys } from '../common/keys';
import { knownVasp } from '../common/sanctions';
import { JsonStore } from '../common/store';

const SERVICE = 'sq-core' as const;
const d = loadDeployment();
const keys = await ensureKeys(SERVICE);
const omnibus = accountOf(keys.omnibusPrivateKey);
const pc = publicClient(d);
const wc = walletClient(d, omnibus);
const issuerKey = await importJWK(keys.credentialIssuerJwk, 'ES256');
const { d: _priv, ...issuerPublicJwk } = keys.credentialIssuerJwk as JWK & { d?: string };
const ISSUER = 'https://www.swissquote.ch/rutli/issuer (demo)';

interface Notification {
  id: string;
  at: number;
  level: 'info' | 'warning' | 'danger' | 'success';
  title: string;
  body: string;
  channels: string[];
}
interface Transfer {
  id: string;
  at: number;
  direction: 'to-wallet' | 'from-wallet' | 'blocked';
  amount: string;
  counterparty: string;
  txHash?: Hex;
  travelRule: string;
}
interface Wallet {
  account: Address;
  salt: Hex;
  cfg: Record<string, unknown>;
  cosigner: Address;
  guardian: Address;
  card: Address;
  passkey: { x: Hex; y: Hex };
  deployTx?: Hex;
  ownership?: { verifiedAt: number; method: string; challenge: Hex };
  createdAt: number;
}
interface Client {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  nationality: string;
  email: string;
  phone: string;
  postalAddress: string;
  persona: string;
  password: string;
  custodial: { chf: string; usdc: string };
  trustedContact: { name: string; phone: string };
  pending?: { cosigner: Address; guardian: Address; salt: Hex; nonce: Hex; mailboxId: string };
  wallet?: Wallet;
  notifications: Notification[];
  transfers: Transfer[];
}

const CLAIRE: Client = {
  id: 'claire',
  name: 'Claire Dubois',
  firstName: 'Claire',
  lastName: 'Dubois',
  birthDate: '1968-04-12',
  nationality: 'CH',
  email: 'claire.dubois@example.ch',
  phone: '+41 79 123 45 67',
  postalAddress: 'Avenue de la Gare 12, 1003 Lausanne',
  persona: 'claire',
  password: 'demo',
  custodial: { chf: '125000.00', usdc: '25000000000' }, // 25'000 USDC held by Swissquote for Claire
  trustedContact: { name: 'Marc Dubois (husband)', phone: '+41 79 765 43 21' },
  notifications: [],
  transfers: [],
};

const db = new JsonStore(SERVICE, 'db', () => ({
  clients: { claire: CLAIRE } as Record<string, Client>,
  sessions: {} as Record<string, { clientId: string; device: string; createdAt: number }>,
  lastScannedBlock: '0',
}));

const internal = { 'x-sq-internal-key': SWISSQUOTE_INTERNAL_KEY };
const partner = { 'x-partner-key': POSTE_PARTNER_KEY };

function session(req: Parameters<typeof bearer>[0]): Client {
  const s = db.data.sessions[bearer(req)];
  if (!s) throw new HttpError(401, 'session expired, please log in');
  return db.data.clients[s.clientId]!;
}

function notify(c: Client, n: Omit<Notification, 'id' | 'at'>) {
  db.update(() => {
    c.notifications.unshift({ id: randomUUID(), at: Date.now(), ...n });
    c.notifications = c.notifications.slice(0, 100);
  });
}

function publicProfile(c: Client) {
  const { password: _p, pending: _pending, ...rest } = c;
  return {
    ...rest,
    unread: c.notifications.length,
    wallet: c.wallet
      ? {
          account: c.wallet.account,
          card: c.wallet.card,
          cosigner: c.wallet.cosigner,
          guardian: c.wallet.guardian,
          passkey: c.wallet.passkey,
          ownership: c.wallet.ownership,
          createdAt: c.wallet.createdAt,
        }
      : undefined,
  };
}

const app = createApp(SERVICE);

/** Public configuration for the app (contracts, chain, service URLs, demo parameters). */
app.get('/config', (_req, res) => {
  res.json(d);
});

// ── Session (MOCK login: in production, Swissquote's existing login + 2FA) ─────────────

app.post('/session/login', (req, res) => {
  const { clientId, password, device } = req.body ?? {};
  const c = db.data.clients[clientId];
  if (!c || c.password !== password) throw new HttpError(401, 'wrong credentials (demo: claire / demo)');
  const token = randomBytes(24).toString('base64url');
  db.update((s) => (s.sessions[token] = { clientId, device: String(device ?? 'unknown'), createdAt: Date.now() }));
  res.json({ token, client: publicProfile(c) });
});

app.get('/internal/session/:token', (req, res) => {
  requireInternal(req);
  const s = db.data.sessions[req.params.token!];
  if (!s) throw new HttpError(404, 'no session');
  const c = db.data.clients[s.clientId]!;
  res.json({ clientId: s.clientId, account: c.wallet?.account, name: c.name });
});

app.get('/internal/clients/by-account/:account', (req, res) => {
  requireInternal(req);
  const a = req.params.account!.toLowerCase();
  const c = Object.values(db.data.clients).find((x) => x.wallet?.account.toLowerCase() === a);
  if (!c) throw new HttpError(404, 'unknown wallet');
  res.json({ clientId: c.id, name: c.name, birthDate: c.birthDate });
});

app.get('/me', (req, res) => {
  res.json(publicProfile(session(req)));
});

// ── Wallet onboarding ─────────────────────────────────────────────────────────────────

/** Step 1: Swissquote obtains the per-client co-signer key and enrolls the client at La Poste. */
app.post('/wallet/prepare', async (req, res) => {
  const c = session(req);
  if (c.wallet) throw new HttpError(409, 'wallet already exists');
  const { cosigner } = await api<{ cosigner: Address }>(`${SERVICE_URLS.cosigner}/internal/clients/${c.id}/key`, {
    method: 'POST',
    headers: internal,
    body: {},
  });
  const { guardian, mailboxId } = await api<{ guardian: Address; mailboxId: string }>(`${SERVICE_URLS.poste}/enroll`, {
    headers: partner,
    body: { clientId: c.id, name: c.name, postalAddress: c.postalAddress },
  });
  await api(`${SERVICE_URLS.videoIdent}/references`, {
    headers: internal,
    body: { clientId: c.id, persona: c.persona, name: c.name },
  });
  const salt = keccak256(toHex(`${c.id}:${randomUUID()}`));
  const nonce = toHex(randomBytes(32));
  db.update(() => (c.pending = { cosigner, guardian, salt, nonce, mailboxId }));
  res.json({
    cosigner,
    guardian,
    salt,
    ownershipNonce: nonce,
    factory: d.contracts.factory,
    recoveryDelay: d.params.recoveryDelay,
    exitDelay: d.params.exitDelay,
    allowanceTokens: [d.contracts.usdc],
    allowanceLimits: [d.params.dailyLimitUsdc],
  });
});

/**
 * Step 2: the app sends the configuration (with the passkey public key and the card address) and an
 * ownership proof signed by the passkey. Swissquote checks it against the CREATE2 address — Travel Rule
 * ownership verification by technical means — then deploys the wallet (Swissquote pays the gas).
 */
app.post('/wallet/activate', async (req, res) => {
  const c = session(req);
  if (c.wallet) throw new HttpError(409, 'wallet already exists');
  const p = c.pending;
  if (!p) throw new HttpError(409, 'call /wallet/prepare first');
  const cfg = req.body?.cfg;
  const proof = req.body?.ownershipProof as Hex;
  if (!cfg || !proof) throw new HttpError(400, 'cfg and ownershipProof required');

  if (getAddress(cfg.cosigner) !== getAddress(p.cosigner) || getAddress(cfg.guardian) !== getAddress(p.guardian)) {
    throw new HttpError(400, 'The configuration must use the keys Swissquote and La Poste issued for you');
  }
  if (
    cfg.allowanceTokens?.length !== 1 ||
    getAddress(cfg.allowanceTokens[0]) !== getAddress(d.contracts.usdc) ||
    BigInt(cfg.allowanceLimits[0]) > BigInt(d.params.dailyLimitUsdc)
  ) {
    throw new HttpError(400, 'Unexpected daily wallet allowance');
  }
  const config = { ...cfg, allowanceLimits: (cfg.allowanceLimits as string[]).map((x) => BigInt(x)) };
  const account = await pc.readContract({
    address: d.contracts.factory,
    abi: rutliFactoryAbi,
    functionName: 'getAddress',
    args: [config, p.salt],
  });
  const challenge = ownershipChallenge({ clientId: c.id, account, chainId: d.chainId, nonce: p.nonce });
  if (!verifyWebAuthnFactor(challenge, proof, cfg.passkeyX, cfg.passkeyY)) {
    throw new HttpError(403, 'Ownership proof invalid: the passkey did not sign the challenge');
  }

  const deployed = await api<{ account: Address; txHash?: Hex }>(`${SERVICE_URLS.gasStation}/deploy`, {
    headers: internal,
    body: { cfg, salt: p.salt },
  });
  if (getAddress(deployed.account) !== getAddress(account)) throw new HttpError(500, 'address mismatch');
  await api(`${SERVICE_URLS.cosigner}/internal/clients/${c.id}/account`, { headers: internal, body: { account } });

  const wallet: Wallet = {
    account,
    salt: p.salt,
    cfg,
    cosigner: p.cosigner,
    guardian: p.guardian,
    card: getAddress(cfg.card),
    passkey: { x: cfg.passkeyX, y: cfg.passkeyY },
    deployTx: deployed.txHash,
    ownership: {
      verifiedAt: Date.now(),
      method: `${OWNERSHIP_PROOF_TAG}: WebAuthn signature by the wallet's own passkey, bound to the CREATE2 address (FINMA Guidance 02/2019 "technical means")`,
      challenge,
    },
    createdAt: Date.now(),
  };
  db.update(() => {
    c.wallet = wallet;
    c.pending = undefined;
  });
  notify(c, {
    level: 'success',
    title: 'Your Rütli wallet is ready',
    body: `Address ${account}. Ownership verified automatically for the Travel Rule: transfers with your Swissquote account are instant.`,
    channels: ['app', 'email'],
  });
  res.json({ account, txHash: deployed.txHash, ownership: wallet.ownership });
});

// ── Transfers between the bank and the wallet (Travel Rule) ───────────────────────────

async function sendFromOmnibus(c: Client, to: Address, amount: bigint, travelRule: string) {
  if (BigInt(c.custodial.usdc) < amount) throw new HttpError(400, 'Insufficient USDC on your Swissquote account');
  const hash = await wc.writeContract({ address: d.contracts.usdc, abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new HttpError(500, 'transfer failed');
  db.update(() => {
    c.custodial.usdc = (BigInt(c.custodial.usdc) - amount).toString();
    c.transfers.unshift({ id: randomUUID(), at: Date.now(), direction: 'to-wallet', amount: amount.toString(), counterparty: to, txHash: hash, travelRule });
  });
  return hash;
}

app.post('/transfers/to-wallet', async (req, res) => {
  const c = session(req);
  if (!c.wallet?.ownership) throw new HttpError(409, 'No verified wallet');
  const amount = BigInt(req.body?.amount ?? 0);
  if (amount <= 0n) throw new HttpError(400, 'amount required');
  const travelRule =
    `Originator: ${c.name} (Swissquote client ${c.id}). Beneficiary: ${c.name}, self-hosted wallet ${c.wallet.account}. ` +
    `Ownership verified by technical means on ${new Date(c.wallet.ownership.verifiedAt).toISOString().slice(0, 10)} — no manual check needed.`;
  const txHash = await sendFromOmnibus(c, c.wallet.account, amount, travelRule);
  notify(c, {
    level: 'info',
    title: `${formatUsdc(amount)} USDC sent to your wallet`,
    body: 'Instant: your wallet ownership was verified at creation (Travel Rule).',
    channels: ['app'],
  });
  res.json({ txHash, travelRule });
});

/** A withdrawal to any other external address: blocked until ownership is verified (the status quo). */
app.post('/transfers/to-external', async (req, res) => {
  const c = session(req);
  const to = getAddress(req.body?.address);
  const amount = BigInt(req.body?.amount ?? 0);
  if (c.wallet && to === getAddress(c.wallet.account)) {
    const txHash = await sendFromOmnibus(c, to, amount, 'Own verified Rütli wallet');
    res.json({ txHash });
    return;
  }
  const vasp = knownVasp(to);
  const reason = vasp
    ? `Transfer to ${vasp.name}: Travel Rule data (IVMS101) would be exchanged with the receiving institution.`
    : 'FINMA Guidance 02/2019: Swissquote may only send crypto to an external self-hosted wallet after verifying who controls it. ' +
      'This address is not verified: manual process (signed message or test transfer + review), typically 1–3 business days.';
  db.update(() =>
    c.transfers.unshift({ id: randomUUID(), at: Date.now(), direction: 'blocked', amount: amount.toString(), counterparty: to, travelRule: reason }),
  );
  throw new HttpError(403, reason);
});

/** Deposits from the client's verified wallet back to the bank are credited instantly (origin verified). */
async function scanDeposits() {
  try {
    const latest = await pc.getBlockNumber();
    const from = BigInt(db.data.lastScannedBlock) + 1n;
    if (from > latest) return;
    const logs = await pc.getLogs({
      address: d.contracts.usdc,
      event: erc20Abi.find((x) => x.type === 'event' && x.name === 'Transfer')!,
      args: { to: omnibus.address },
      fromBlock: from,
      toBlock: latest,
    });
    const parsed = parseEventLogs({ abi: erc20Abi, logs, eventName: 'Transfer' });
    for (const log of parsed) {
      const sender = log.args.from.toLowerCase();
      const c = Object.values(db.data.clients).find((x) => x.wallet?.account.toLowerCase() === sender);
      if (!c) continue;
      const amount = log.args.value;
      db.update(() => {
        c.custodial.usdc = (BigInt(c.custodial.usdc) + amount).toString();
        c.transfers.unshift({
          id: randomUUID(),
          at: Date.now(),
          direction: 'from-wallet',
          amount: amount.toString(),
          counterparty: log.args.from,
          txHash: log.transactionHash,
          travelRule: 'Originator wallet = client’s own verified Rütli wallet: credited instantly',
        });
      });
      notify(c, {
        level: 'success',
        title: `${formatUsdc(amount)} USDC credited to your Swissquote account`,
        body: 'From your own verified wallet: no Travel Rule hold.',
        channels: ['app'],
      });
    }
    db.update((s) => (s.lastScannedBlock = latest.toString()));
  } catch {
    /* chain not reachable yet */
  }
}
setInterval(scanDeposits, 3000);

// ── Notifications ─────────────────────────────────────────────────────────────────────

app.get('/notifications', (req, res) => {
  res.json(session(req).notifications);
});

app.post('/internal/notify', (req, res) => {
  requireInternal(req);
  const { clientId, account, ...n } = req.body ?? {};
  const c =
    (clientId && db.data.clients[clientId]) ||
    Object.values(db.data.clients).find((x) => account && x.wallet?.account.toLowerCase() === String(account).toLowerCase());
  if (!c) throw new HttpError(404, 'client not found');
  notify(c, { level: n.level ?? 'info', title: n.title, body: n.body, channels: n.channels ?? ['app'] });
  res.json({ ok: true });
});

// ── Theft hotline: "blocking is easy" ─────────────────────────────────────────────────

app.post('/hotline/report-theft', async (req, res) => {
  const { clientId, birthDate } = req.body ?? {};
  const c = db.data.clients[clientId];
  // Deliberately low bar: freezing can only BLOCK Face-ID spending, never move or unlock anything.
  if (!c || c.birthDate !== birthDate) throw new HttpError(403, 'Could not identify the client');
  const r = await api<{ txHash?: Hex; frozenUntil?: number }>(`${SERVICE_URLS.cosigner}/internal/theft-report`, {
    headers: internal,
    body: { clientId: c.id },
  });
  notify(c, {
    level: 'danger',
    title: 'Phone reported stolen — wallet frozen',
    body: 'Face-ID-only spending is blocked and Swissquote will not co-sign anything with your old phone. Recover with your card or with La Poste.',
    channels: ['app', 'email', 'sms', `trusted contact: ${c.trustedContact.name}`],
  });
  res.json(r);
});

// ── Portable wallet-ownership credential (SD-JWT VC, swiyu-compatible format) ──────────

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sdDigest = (disclosure: string) => b64url(createHash('sha256').update(disclosure).digest());

app.post('/credentials/ownership', async (req, res) => {
  const c = session(req);
  if (!c.wallet?.ownership) throw new HttpError(409, 'No verified wallet');
  const claims: Array<[string, unknown]> = [
    ['given_name', c.firstName],
    ['family_name', c.lastName],
    ['birthdate', c.birthDate],
    ['nationality', c.nationality],
  ];
  const disclosures = claims.map(([k, v]) => b64url(JSON.stringify([b64url(randomBytes(16)), k, v])));
  const jwt = await new SignJWT({
    vct: 'urn:swissquote:rutli:WalletOwnershipCredential:1',
    wallet: { chainId: d.chainId, address: c.wallet.account, type: 'self-hosted (Rütli smart account)' },
    ownership_verified_at: Math.floor(c.wallet.ownership.verifiedAt / 1000),
    ownership_method: 'WebAuthn proof bound to the CREATE2 address + bank KYC (AMLA)',
    kyc_by: 'Swissquote Bank SA (FINMA-licensed bank) — demo',
    _sd: disclosures.map(sdDigest),
    _sd_alg: 'sha-256',
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'dc+sd-jwt', kid: 'sq-issuer-demo' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('365d')
    .sign(issuerKey);
  res.json({ sdJwt: `${jwt}~${disclosures.join('~')}~`, disclosures: claims.map(([k], i) => ({ claim: k, disclosure: disclosures[i] })) });
});

app.get('/issuer/jwks', (_req, res) => {
  res.json({ keys: [{ ...issuerPublicJwk, kid: 'sq-issuer-demo', alg: 'ES256', use: 'sig' }] });
});

/** Acts as ANOTHER regulated institution verifying a presented credential (selective disclosure). */
app.post('/verify/ownership', async (req, res) => {
  const presentation = String(req.body?.sdJwt ?? '');
  const [jwt, ...rest] = presentation.split('~');
  const disclosures = rest.filter(Boolean);
  const { payload } = await jwtVerify(jwt!, await importJWK(issuerPublicJwk as JWK, 'ES256'), { issuer: ISSUER });
  const allowed = new Set((payload._sd as string[]) ?? []);
  const disclosed: Record<string, unknown> = {};
  for (const disc of disclosures) {
    if (!allowed.has(sdDigest(disc))) throw new HttpError(400, 'A disclosure does not belong to this credential');
    const [, name, value] = JSON.parse(Buffer.from(disc, 'base64url').toString());
    disclosed[name] = value;
  }
  const wallet = payload.wallet as { address: Address; chainId: number };
  const code = await pc.getCode({ address: wallet.address });
  const isRutli = !!code && code.toLowerCase().includes(d.contracts.implementation.slice(2).toLowerCase());
  res.json({
    valid: true,
    issuer: payload.iss,
    wallet,
    onChainCheck: isRutli ? 'Rütli smart account found on-chain' : 'not found on-chain',
    disclosed,
    hidden: allowed.size - disclosures.length,
  });
});

// ── Back-office (demo) ────────────────────────────────────────────────────────────────

app.get('/ops/overview', (_req, res) => {
  res.json(
    Object.values(db.data.clients).map((c) => ({
      id: c.id,
      name: c.name,
      custodial: c.custodial,
      wallet: c.wallet?.account,
      ownershipVerified: !!c.wallet?.ownership,
      transfers: c.transfers.slice(0, 20),
    })),
  );
});

start(app, SERVICE, `Swissquote core banking (omnibus wallet ${omnibus.address})`);
