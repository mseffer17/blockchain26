/**
 * LA POSTE — INDEPENDENT GUARDIAN (factor G)                                              [MOCK]
 *
 * An independent Swiss institution (La Poste already performs identity checks at its counters for banks)
 * holds one guardian key per client. It signs ONLY an `initiateRecovery` user operation, and only when:
 *   1. Swissquote opened a recovery case through the partner API;
 *   2. the code printed in a letter mailed to the client's postal address (La Poste's own records)
 *      has been typed back by the person recovering — proof of access to the physical mailbox,
 *      which a phone/e-mail thief does not have;
 *   3. the operation is exactly the recovery of that case (same wallet, same new keys).
 *
 * La Poste never sees the funds and can never sign a transfer. Even together with Swissquote, a recovery
 * only starts a public delay during which the client cancels it with Face ID or the card.
 */
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Address, Hex } from 'viem';
import { Factor, decodeAccountCall, deserializeUserOp, getUserOpHash, type SerializedUserOp } from '@rutli/sdk';
import { loadDeployment } from '../common/config';
import { HttpError, createApp, requirePartner, start } from '../common/http';
import { deriveClientAccount, ensureKeys } from '../common/keys';
import { JsonStore } from '../common/store';

const SERVICE = 'poste-guardian' as const;
const d = loadDeployment();
const keys = await ensureKeys(SERVICE);

interface Letter {
  id: string;
  at: number;
  from: string;
  subject: string;
  lines: string[];
  code: string;
  caseRef: string;
}
interface Case {
  id: string;
  clientId: string;
  account: Address;
  newPasskeyX: Hex;
  newPasskeyY: Hex;
  newCard: Address;
  reason: string;
  codeHash: string;
  attempts: number;
  status: 'letter_sent' | 'code_verified' | 'signed' | 'locked';
  createdAt: number;
}

const db = new JsonStore(SERVICE, 'db', () => ({
  nextIndex: 0,
  clients: {} as Record<string, { index: number; guardian: Address; name: string; postalAddress: string; mailboxId: string }>,
  cases: {} as Record<string, Case>,
  mailboxes: {} as Record<string, { address: string; owner: string; letters: Letter[] }>,
}));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () =>
  Array.from({ length: 8 }, (_, i) => (i === 4 ? '-' : '') + ALPHABET[randomInt(ALPHABET.length)]).join('');
const normalizeCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** "Avenue de la Gare 12, 1003 Lausanne" → "•••••••••, 1003 Lausanne" (the letter's destination, masked). */
const mask = (address: string) => {
  const [street, ...rest] = address.split(',');
  return `${'•'.repeat(Math.min(street?.length ?? 6, 12))}, ${rest.join(',').trim()}`;
};

function clientKey(clientId: string) {
  const c = db.data.clients[clientId];
  if (!c) throw new HttpError(404, 'client not enrolled at La Poste');
  return deriveClientAccount(keys.seedMnemonic, c.index);
}

const app = createApp(SERVICE);

/** Swissquote enrolls a client (with the client's consent) at onboarding. */
app.post('/enroll', (req, res) => {
  requirePartner(req);
  const { clientId, name, postalAddress } = req.body ?? {};
  if (!clientId || !name || !postalAddress) throw new HttpError(400, 'clientId, name, postalAddress required');
  let c = db.data.clients[clientId];
  if (!c) {
    const index = db.data.nextIndex;
    const guardian = deriveClientAccount(keys.seedMnemonic, index).address;
    const mailboxId = sha(postalAddress.toLowerCase()).slice(0, 12);
    c = { index, guardian, name, postalAddress, mailboxId };
    db.update((s) => {
      s.nextIndex++;
      s.clients[clientId] = c!;
      s.mailboxes[mailboxId] ??= { address: postalAddress, owner: name, letters: [] };
    });
  }
  res.json({ guardian: c.guardian, mailboxId: c.mailboxId });
});

/** Swissquote opens a recovery (or inheritance) case: La Poste mails a code to the registered address. */
app.post('/cases', (req, res) => {
  requirePartner(req);
  const { clientId, account, newPasskeyX, newPasskeyY, newCard, reason } = req.body ?? {};
  const c = db.data.clients[clientId];
  if (!c) throw new HttpError(404, 'client not enrolled at La Poste');
  const code = newCode();
  const kase: Case = {
    id: randomUUID(),
    clientId,
    account,
    newPasskeyX,
    newPasskeyY,
    newCard,
    reason: reason ?? 'LOST_ALL',
    codeHash: sha(normalizeCode(code)),
    attempts: 0,
    status: 'letter_sent',
    createdAt: Date.now(),
  };
  const ref = kase.id.slice(0, 8).toUpperCase();
  const letter: Letter = {
    id: randomUUID(),
    at: Date.now(),
    from: 'La Poste — Service de sécurité des comptes / Account security',
    subject: 'Recommandé — Code de confirmation de récupération / Recovery confirmation code',
    lines: [
      `Madame ${c.name},`,
      `Swissquote nous informe d'une demande de récupération de votre portefeuille numérique (dossier ${ref}).`,
      'Si vous êtes à l’origine de cette demande, saisissez le code ci-dessous dans l’application.',
      'Si ce n’est PAS vous : ne communiquez ce code à personne et appelez Swissquote. Votre portefeuille vous permet aussi d’annuler la demande avec Face ID ou votre carte de secours.',
      '—',
      `A recovery was requested for your wallet (case ${ref}). If it was not you, do not share this code.`,
    ],
    code,
    caseRef: ref,
  };
  db.update((s) => {
    s.cases[kase.id] = kase;
    s.mailboxes[c.mailboxId]!.letters.unshift(letter);
  });
  res.json({ caseId: kase.id, caseRef: ref, letterSentTo: mask(c.postalAddress), delivery: 'registered letter (demo: delivered instantly)' });
});

/** The person recovering types the code from the letter (called from the client's new device). */
app.post('/cases/:id/verify', (req, res) => {
  const kase = db.data.cases[req.params.id!];
  if (!kase) throw new HttpError(404, 'case not found');
  if (kase.status === 'locked') throw new HttpError(423, 'Case locked after too many wrong codes');
  if (kase.status !== 'letter_sent') {
    res.json({ status: kase.status });
    return;
  }
  const given = Buffer.from(sha(normalizeCode(String(req.body?.code ?? ''))), 'hex');
  const ok = timingSafeEqual(given, Buffer.from(kase.codeHash, 'hex'));
  db.update(() => {
    if (ok) kase.status = 'code_verified';
    else if (++kase.attempts >= 3) kase.status = 'locked';
  });
  if (!ok) {
    const locked = (kase.status as Case['status']) === 'locked';
    throw new HttpError(403, locked ? 'Wrong code — case locked' : `Wrong code (${3 - kase.attempts} attempts left)`);
  }
  res.json({ status: kase.status });
});

/** Swissquote asks La Poste to co-sign the recovery user operation. */
app.post('/cases/:id/sign', async (req, res) => {
  requirePartner(req);
  const kase = db.data.cases[req.params.id!];
  if (!kase) throw new HttpError(404, 'case not found');
  if (kase.status !== 'code_verified' && kase.status !== 'signed') {
    throw new HttpError(409, 'La Poste has not received the code from the letter: the mailbox check is not complete');
  }
  const op = deserializeUserOp(req.body?.op as SerializedUserOp);
  const intent = decodeAccountCall(op.callData);
  const matches =
    intent.kind === 'initiateRecovery' &&
    op.sender.toLowerCase() === kase.account.toLowerCase() &&
    intent.x.toLowerCase() === kase.newPasskeyX.toLowerCase() &&
    intent.y.toLowerCase() === kase.newPasskeyY.toLowerCase() &&
    intent.newCard.toLowerCase() === kase.newCard.toLowerCase();
  if (!matches) throw new HttpError(403, 'La Poste only signs the exact recovery of this case');
  const hash = getUserOpHash(op, d.contracts.entryPoint, d.chainId);
  const signature = await clientKey(kase.clientId).sign({ hash });
  db.update(() => (kase.status = 'signed'));
  res.json({ factor: Factor.GUARDIAN, data: signature, userOpHash: hash });
});

app.get('/cases', (_req, res) => {
  res.json(
    Object.values(db.data.cases)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ codeHash: _h, ...c }) => c),
  );
});

/** DEMO ONLY: the physical mailboxes (in reality, only the resident can open theirs). */
app.get('/mailboxes', (_req, res) => {
  res.json(Object.entries(db.data.mailboxes).map(([id, m]) => ({ id, address: m.address, owner: m.owner, letters: m.letters.length })));
});

app.get('/mailboxes/:id', (req, res) => {
  const m = db.data.mailboxes[req.params.id!];
  if (!m) throw new HttpError(404, 'mailbox not found');
  res.json(m);
});

start(app, SERVICE, 'La Poste — independent guardian');
