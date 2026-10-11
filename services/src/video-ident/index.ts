/**
 * VIDEO-IDENTIFICATION PROVIDER                                                          [MOCK]
 *
 * Stands in for a FINMA-compliant video/online identification provider (FINMA Circular 2016/7):
 * a trained agent compares the live person with the KYC photo held by the bank, with liveness checks.
 * From 1 December 2026 the Swiss e-ID (swiyu) can provide the same assurance.
 *
 * Mock behaviour: the "camera" presents a demo persona (Claire = the account holder, Mallory = the thief);
 * a similarity score is computed against the KYC reference; with VIDEO_IDENT_AUTO_DECIDE=true the agent
 * decision is automatic, otherwise an agent decides in the app's Ops console.
 *
 * Output: a short-lived signed attestation (ES256 JWT) that Swissquote's co-signer verifies with the
 * provider's public key (JWKS). Swissquote never sees the video, only the signed result.
 */
import { randomUUID } from 'node:crypto';
import { SignJWT, importJWK, type JWK } from 'jose';
import { VIDEO_IDENT_AUTO_DECIDE } from '../common/config';
import { HttpError, createApp, requireInternal, start } from '../common/http';
import { ensureKeys } from '../common/keys';
import { JsonStore } from '../common/store';

const SERVICE = 'video-ident' as const;
const keys = await ensureKeys(SERVICE);
const signingKey = await importJWK(keys.attestationJwk, 'ES256');
const { d: _private, ...publicJwk } = keys.attestationJwk as JWK & { d?: string };
const KID = 'video-ident-demo-2026';

type Status = 'awaiting_capture' | 'in_review' | 'approved' | 'rejected';
interface Session {
  id: string;
  clientId: string;
  purpose: string;
  createdAt: number;
  status: Status;
  presentedPersona?: string;
  hasImage?: boolean;
  similarity?: number;
  liveness?: boolean;
  agent?: string;
  reason?: string;
  decidedAt?: number;
}

/** KYC reference faces received from the bank at onboarding (mock: persona ids). */
const db = new JsonStore(SERVICE, 'db', () => ({
  references: { claire: { persona: 'claire', name: 'Claire Dubois' } } as Record<string, { persona: string; name: string }>,
  sessions: {} as Record<string, Session>,
}));

const app = createApp(SERVICE);

/** The bank registers the KYC reference of a client (done once at onboarding). */
app.post('/references', (req, res) => {
  requireInternal(req);
  const { clientId, persona, name } = req.body ?? {};
  db.update((s) => (s.references[clientId] = { persona, name }));
  res.json({ ok: true });
});

app.post('/sessions', (req, res) => {
  const { clientId, purpose } = req.body ?? {};
  if (!clientId || !purpose) throw new HttpError(400, 'clientId and purpose required');
  if (!db.data.references[clientId]) throw new HttpError(404, 'no KYC reference for this client');
  const s: Session = { id: randomUUID(), clientId, purpose, createdAt: Date.now(), status: 'awaiting_capture' };
  db.update((x) => (x.sessions[s.id] = s));
  res.json({ sessionId: s.id, status: s.status });
});

app.post('/sessions/:id/capture', (req, res) => {
  const s = db.data.sessions[req.params.id!];
  if (!s) throw new HttpError(404, 'session not found');
  if (s.status !== 'awaiting_capture') throw new HttpError(409, `session is ${s.status}`);
  const ref = db.data.references[s.clientId]!;
  const persona = req.body?.persona as string | undefined;
  const hasImage = typeof req.body?.imageDataUrl === 'string';
  // Mock face match: the presented persona against the KYC reference. A raw webcam image always
  // requires a human agent (score 0.5).
  const similarity = persona ? (persona === ref.persona ? 0.97 : 0.08) : hasImage ? 0.5 : 0;
  db.update(() => {
    s.presentedPersona = persona;
    s.hasImage = hasImage;
    s.similarity = similarity;
    s.liveness = true;
    s.status = 'in_review';
  });
  if (VIDEO_IDENT_AUTO_DECIDE && similarity !== 0.5) {
    setTimeout(() => {
      if (s.status !== 'in_review') return;
      db.update(() => {
        s.status = similarity > 0.9 ? 'approved' : 'rejected';
        s.agent = 'auto-agent (demo)';
        s.reason =
          s.status === 'approved'
            ? 'Face matches the KYC photo, liveness confirmed'
            : 'Face does NOT match the KYC photo of the account holder';
        s.decidedAt = Date.now();
      });
    }, 1500);
  }
  res.json({ status: s.status, similarity });
});

/** Agent decision (Ops console). */
app.post('/sessions/:id/decision', (req, res) => {
  const s = db.data.sessions[req.params.id!];
  if (!s) throw new HttpError(404, 'session not found');
  if (s.status !== 'in_review') throw new HttpError(409, `session is ${s.status}`);
  const approve = !!req.body?.approve;
  db.update(() => {
    s.status = approve ? 'approved' : 'rejected';
    s.agent = String(req.body?.agent ?? 'agent');
    s.reason = String(req.body?.reason ?? (approve ? 'Identity confirmed by agent' : 'Identity not confirmed by agent'));
    s.decidedAt = Date.now();
  });
  res.json({ status: s.status });
});

app.get('/sessions/:id', async (req, res) => {
  const s = db.data.sessions[req.params.id!];
  if (!s) throw new HttpError(404, 'session not found');
  let token: string | undefined;
  if (s.status === 'approved') {
    token = await new SignJWT({ purpose: s.purpose, result: 'approved', similarity: s.similarity, liveness: s.liveness })
      .setProtectedHeader({ alg: 'ES256', kid: KID })
      .setIssuer('video-ident.mock')
      .setSubject(s.clientId)
      .setJti(s.id)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(signingKey);
  }
  res.json({ ...s, token });
});

app.get('/sessions', (_req, res) => {
  res.json(Object.values(db.data.sessions).sort((a, b) => b.createdAt - a.createdAt));
});

app.get('/.well-known/jwks.json', (_req, res) => {
  res.json({ keys: [{ ...publicJwk, kid: KID, alg: 'ES256', use: 'sig' }] });
});

start(app, SERVICE, `Video-identification provider (auto-decide: ${VIDEO_IDENT_AUTO_DECIDE})`);
