import type { Address, Hex } from 'viem';
import { api, type Deployment, type SerializedUserOp } from '@rutli/sdk';

export interface Notification {
  id: string;
  at: number;
  level: 'info' | 'warning' | 'danger' | 'success';
  title: string;
  body: string;
  channels: string[];
}
export interface Profile {
  id: string;
  name: string;
  firstName: string;
  birthDate: string;
  email: string;
  phone: string;
  postalAddress: string;
  custodial: { chf: string; usdc: string };
  trustedContact: { name: string; phone: string };
  wallet?: {
    account: Address;
    card: Address;
    cosigner: Address;
    guardian: Address;
    passkey: { x: Hex; y: Hex };
    ownership?: { verifiedAt: number; method: string };
    createdAt: number;
  };
  notifications: Notification[];
  transfers: Array<{ id: string; at: number; direction: string; amount: string; counterparty: string; txHash?: Hex; travelRule: string }>;
}
export interface Check {
  id: string;
  label: string;
  status: 'pass' | 'info' | 'warn' | 'hold' | 'fail';
  detail?: string;
}
export interface Preview {
  summary: string[];
  checks: Check[];
  decision: 'approved' | 'held' | 'refused';
  holdSeconds: number;
}
export interface SendResult {
  success: boolean;
  txHash: Hex;
  error?: string;
  errorName?: string;
  gasPaidBySwissquoteWei?: string;
}
export interface Hold {
  id: string;
  summary: string[];
  reasons: string[];
  createdAt: number;
  releaseAt: number;
  status: 'held' | 'executed' | 'cancelled' | 'failed';
  txHash?: Hex;
  error?: string;
}

export function services(cfg: Deployment, token?: string) {
  const S = cfg.services;
  const t = { token };
  return {
    login: (device: string) =>
      api<{ token: string; client: Profile }>(`${S.sqCore}/session/login`, { body: { clientId: 'claire', password: 'demo', device } }),
    me: () => api<Profile>(`${S.sqCore}/me`, t),
    notifications: () => api<Notification[]>(`${S.sqCore}/notifications`, t),
    prepare: () =>
      api<{
        cosigner: Address;
        guardian: Address;
        salt: Hex;
        ownershipNonce: Hex;
        recoveryDelay: number;
        exitDelay: number;
        allowanceTokens: Address[];
        allowanceLimits: string[];
      }>(`${S.sqCore}/wallet/prepare`, { ...t, body: {} }),
    activate: (cfgBody: unknown, ownershipProof: Hex) =>
      api<{ account: Address; txHash: Hex }>(`${S.sqCore}/wallet/activate`, { ...t, body: { cfg: cfgBody, ownershipProof } }),
    toWallet: (amount: bigint) => api<{ txHash: Hex; travelRule: string }>(`${S.sqCore}/transfers/to-wallet`, { ...t, body: { amount: amount.toString() } }),
    toExternal: (address: string, amount: bigint) =>
      api<{ txHash: Hex }>(`${S.sqCore}/transfers/to-external`, { ...t, body: { address, amount: amount.toString() } }),
    reportTheft: (birthDate: string) =>
      api<{ txHash?: Hex; frozenUntil?: number }>(`${S.sqCore}/hotline/report-theft`, { body: { clientId: 'claire', birthDate } }),
    credential: () =>
      api<{ sdJwt: string; disclosures: Array<{ claim: string; disclosure: string }> }>(`${S.sqCore}/credentials/ownership`, { ...t, body: {} }),
    verifyCredential: (sdJwt: string) =>
      api<{ valid: boolean; issuer: string; wallet: { address: string; chainId: number }; onChainCheck: string; disclosed: Record<string, unknown>; hidden: number }>(
        `${S.sqCore}/verify/ownership`,
        { body: { sdJwt } },
      ),

    sponsor: (op: SerializedUserOp, purpose: string) =>
      api<{ op: SerializedUserOp; userOpHash: Hex; validUntil: number }>(`${S.gasStation}/sponsor`, { body: { op, purpose } }),
    send: (op: SerializedUserOp) => api<SendResult>(`${S.gasStation}/send`, { body: { op } }),
    finalize: (account: Address, kind: 'recovery' | 'exit') => api<{ txHash: Hex }>(`${S.gasStation}/relay/finalize`, { body: { account, kind } }),

    policy: () =>
      api<{ approvedDapps: Array<{ address: Address; name: string; category: string; risk: string }>; holdSeconds: number; holdThresholdUsdc: string }>(
        `${S.cosigner}/policy`,
      ),
    preview: (op: SerializedUserOp) => api<Preview>(`${S.cosigner}/preview`, { ...t, body: { op } }),
    cosign: (op: SerializedUserOp) =>
      api<(SendResult & { decision: 'approved' }) | { decision: 'held'; holdId: string; releaseAt: number }>(`${S.cosigner}/cosign`, {
        ...t,
        body: { op },
      }),
    holds: () => api<Hold[]>(`${S.cosigner}/holds`, t),
    cancelHold: (id: string) => api(`${S.cosigner}/holds/${id}`, { ...t, method: 'DELETE' }),
    rotatePasskey: (op: SerializedUserOp, identToken: string) =>
      api<SendResult>(`${S.cosigner}/recovery/rotate-passkey`, { ...t, body: { op, identToken } }),
    rotateCard: (op: SerializedUserOp, identToken: string) => api<SendResult>(`${S.cosigner}/recovery/rotate-card`, { ...t, body: { op, identToken } }),
    guardianStart: (b: { newPasskeyX: Hex; newPasskeyY: Hex; newCard: Address; identToken: string; reason: string }) =>
      api<{ caseId: string; posteCaseId: string; caseRef: string; letterSentTo: string }>(`${S.cosigner}/recovery/guardian/start`, { ...t, body: b }),
    guardianSubmit: (id: string) => api<{ status: string; txHash: Hex; executeAfter: number }>(`${S.cosigner}/recovery/guardian/${id}/submit`, { ...t, body: {} }),

    identStart: (purpose: string) => api<{ sessionId: string }>(`${S.videoIdent}/sessions`, { body: { clientId: 'claire', purpose } }),
    identCapture: (id: string, persona: string) => api<{ status: string; similarity: number }>(`${S.videoIdent}/sessions/${id}/capture`, { body: { persona } }),
    identStatus: (id: string) =>
      api<{ status: 'awaiting_capture' | 'in_review' | 'approved' | 'rejected'; token?: string; reason?: string; similarity?: number }>(
        `${S.videoIdent}/sessions/${id}`,
      ),
    identSessions: () => api<Array<Record<string, unknown>>>(`${S.videoIdent}/sessions`),
    identDecide: (id: string, approve: boolean) =>
      api(`${S.videoIdent}/sessions/${id}/decision`, { body: { approve, agent: 'Agent R. Favre (Ops console)' } }),

    posteVerify: (caseId: string, code: string) => api<{ status: string }>(`${S.poste}/cases/${caseId}/verify`, { body: { code } }),
    mailboxes: () => api<Array<{ id: string; address: string; owner: string; letters: number }>>(`${S.poste}/mailboxes`),
    mailbox: (id: string) =>
      api<{ address: string; owner: string; letters: Array<{ id: string; at: number; from: string; subject: string; lines: string[]; code: string; caseRef: string }> }>(
        `${S.poste}/mailboxes/${id}`,
      ),
    posteCases: () => api<Array<Record<string, unknown>>>(`${S.poste}/cases`),

    opsCore: () => api<Array<Record<string, unknown>>>(`${S.sqCore}/ops/overview`),
    opsCosigner: () => api<Record<string, unknown>>(`${S.cosigner}/ops/overview`),
    gasStats: () => api<Record<string, unknown>>(`${S.gasStation}/stats`),
    alerts: () => api<{ accounts: string[]; alerts: Array<Record<string, unknown>> }>(`${S.watchtower}/alerts`),
  };
}

export type Services = ReturnType<typeof services>;
