import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Address, Hex } from 'viem';
import {
  ApiError,
  Factor,
  cardAccount,
  cardSign,
  decodeAccountCall,
  describeIntent,
  isValidCard,
  serializeUserOp,
  shortAddress,
  type FactorSignature,
  type PackedUserOp,
} from '@rutli/sdk';
import { useApp } from '../lib/app';
import { demoCards, deviceSign } from '../lib/device';
import { withSignatures } from '../lib/ops';
import type { Check, Preview, SendResult } from '../lib/services';
import { Seal, type KeyId, type KeyState } from './Seal';
import { Button, Notice, TxLink, WallCountdown, errorText } from './ui';

// ── Bottom sheet ────────────────────────────────────────────────────────────────────

export function Sheet({ children, onClose, label }: { children: ReactNode; onClose: () => void; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" aria-hidden />
        {children}
      </div>
    </div>
  );
}

// ── Checks list (Swissquote's analysis) ─────────────────────────────────────────────

const ICON: Record<Check['status'], string> = { pass: '✓', info: 'i', warn: '!', hold: '◷', fail: '✕' };

export function Checks({ checks }: { checks: Check[] }) {
  return (
    <ul className="checks">
      {checks.map((c, i) => (
        <li key={`${c.id}-${i}`} className={`check check-${c.status}`}>
          <span className="check-icon" aria-hidden>
            {ICON[c.status]}
          </span>
          <span>
            <span className="check-label">{c.label}</span>
            {c.detail && <span className="check-detail">{c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

// ── Recovery card entry ─────────────────────────────────────────────────────────────

export function CardEntry({
  expected,
  onWords,
  onCancel,
  title = 'Your recovery card',
}: {
  expected?: Address;
  onWords: (words: string) => void;
  onCancel: () => void;
  title?: string;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const cards = demoCards();
  const submit = (words: string) => {
    if (!isValidCard(words)) return setError('These are not the 12 words of a recovery card.');
    const addr = cardAccount(words).address;
    if (expected && addr.toLowerCase() !== expected.toLowerCase()) {
      return setError(`This card (${shortAddress(addr)}) is not the card registered on your wallet (${shortAddress(expected)}).`);
    }
    onWords(words);
  };
  return (
    <div className="card-entry">
      <h2>{title}</h2>
      <p className="muted">Type the 12 words printed on your card, or scan its QR code.</p>
      <textarea
        className="input words"
        rows={3}
        value={text}
        placeholder="word1 word2 word3 …"
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      {error && <p className="error-text">{error}</p>}
      <Button onClick={() => submit(text)} disabled={!text.trim()}>
        Use this card
      </Button>
      {cards.length > 0 && (
        <div className="demo-shortcut">
          <p className="muted small">Demo shortcut — on stage we skip typing; a real card is never stored on a device:</p>
          {cards.map((c) => (
            <button key={c.address} type="button" className="chip" onClick={() => submit(c.words)}>
              Card {shortAddress(c.address)}
              {expected && c.address.toLowerCase() === expected.toLowerCase() ? ' (registered)' : ''}
            </button>
          ))}
        </div>
      )}
      <Button kind="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

// ── Video identification ────────────────────────────────────────────────────────────

export function IdentStep({ purpose, onToken, intro }: { purpose: string; onToken: (token: string) => void; intro?: ReactNode }) {
  const { svc, holder } = useApp();
  const [status, setStatus] = useState<'idle' | 'review' | 'approved' | 'rejected'>('idle');
  const [reason, setReason] = useState<string>();
  const [persona, setPersona] = useState<'claire' | 'mallory'>(holder);
  const stop = useRef(false);
  useEffect(() => {
    stop.current = false; // StrictMode re-mounts: re-arm after the simulated unmount
    return () => {
      stop.current = true;
    };
  }, []);

  const start = async (p: 'claire' | 'mallory') => {
    setPersona(p);
    setStatus('review');
    setReason(undefined);
    const { sessionId } = await svc.identStart(purpose);
    await svc.identCapture(sessionId, p);
    for (let i = 0; i < 240 && !stop.current; i++) {
      const s = await svc.identStatus(sessionId);
      if (s.status === 'approved' && s.token) {
        setStatus('approved');
        setReason(s.reason);
        setTimeout(() => onToken(s.token!), 600);
        return;
      }
      if (s.status === 'rejected') {
        setStatus('rejected');
        setReason(s.reason);
        return;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  };

  return (
    <div className="ident">
      <h3>Video identification</h3>
      {intro ?? (
        <p className="muted">
          A certified provider compares your face with the photo from your account opening, with liveness checks. Swissquote only
          receives a signed yes or no.
        </p>
      )}
      <div className="ident-cam" data-state={status}>
        <img src={`/personas/${persona}.svg`} alt={persona === 'claire' ? 'Claire in front of the camera' : 'Mallory in front of the camera'} />
        <span className="ident-status">
          {status === 'idle' && 'Camera ready'}
          {status === 'review' && 'Agent reviewing…'}
          {status === 'approved' && 'Identity confirmed'}
          {status === 'rejected' && 'Identity not confirmed'}
        </span>
      </div>
      {reason && <p className={status === 'rejected' ? 'error-text' : 'ok-text'}>{reason}</p>}
      {(status === 'idle' || status === 'rejected') && (
        <>
          <p className="muted small">Demo: choose who is in front of the camera.</p>
          <div className="row">
            <Button kind="secondary" wide={false} onClick={() => void start('claire')}>
              Claire’s face
            </Button>
            <Button kind="secondary" wide={false} onClick={() => void start('mallory')}>
              Mallory’s face
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Signing flow ────────────────────────────────────────────────────────────────────

export type SignMode = 'passkey' | 'coffre' | 'card' | 'passkey+card';

const REQUIRED: Record<SignMode, KeyId[]> = {
  passkey: ['P'],
  coffre: ['P', 'S'],
  card: ['C'],
  'passkey+card': ['P', 'C'],
};

type Phase = 'preparing' | 'review' | 'card' | 'signing' | 'done' | 'held' | 'refused' | 'error';

export function SignFlow({
  title,
  mode: initialMode,
  build,
  onClose,
  onDone,
  note,
  allowCardOverride = true,
}: {
  title: string;
  mode: SignMode;
  build: () => Promise<{ op: PackedUserOp; hash: Hex }>;
  onClose: () => void;
  onDone?: (r: SendResult) => void;
  note?: ReactNode;
  allowCardOverride?: boolean;
}) {
  const app = useApp();
  const { svc, passkey, names, wallet, refresh } = app;
  const [mode, setMode] = useState<SignMode>(initialMode);
  const [phase, setPhase] = useState<Phase>('preparing');
  const [prepared, setPrepared] = useState<{ op: PackedUserOp; hash: Hex }>();
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<SendResult>();
  const [hold, setHold] = useState<{ id: string; releaseAt: number }>();
  const [signed, setSigned] = useState<Partial<Record<KeyId, KeyState>>>({});
  const [ack, setAck] = useState(false);
  const pSig = useRef<FactorSignature | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await build();
        if (cancelled) return;
        setPrepared(p);
        if (initialMode === 'coffre') setPreview(await svc.preview(serializeUserOp(p.op)).catch(() => undefined));
        setPhase('review');
      } catch (e) {
        if (!cancelled) {
          setError(errorText(e));
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = prepared ? describeIntent(decodeAccountCall(prepared.op.callData), names) : [];
  const required = REQUIRED[mode];
  const sealStates: Partial<Record<KeyId, KeyState>> = { ...Object.fromEntries(required.map((k) => [k, 'required'])), ...signed };
  if (phase === 'refused') sealStates.S = 'refused';

  const finish = async (r: SendResult) => {
    setResult(r);
    if (r.success) {
      setPhase('done');
      onDone?.(r);
    } else {
      setError(r.error ?? 'The operation reverted');
      setPhase('error');
    }
    void refresh();
  };

  const signPasskey = async (): Promise<FactorSignature> => {
    if (pSig.current) return pSig.current;
    if (!passkey || !prepared) throw new Error('No passkey on this device');
    const data = await deviceSign(passkey, prepared.hash);
    pSig.current = { factor: Factor.PASSKEY, data };
    setSigned((s) => ({ ...s, P: 'signed' }));
    return pSig.current;
  };

  const confirm = async () => {
    if (!prepared) return;
    if (mode === 'card' || mode === 'passkey+card') {
      setPhase('card');
      return;
    }
    setPhase('signing');
    setError(undefined);
    try {
      const p = await signPasskey();
      if (mode === 'passkey') {
        await finish(await svc.send(withSignatures(prepared.op, [p])));
        return;
      }
      // coffre: Swissquote co-signs (or holds, or refuses)
      try {
        const r = await svc.cosign(withSignatures(prepared.op, [p]));
        if (r.decision === 'held') {
          setHold({ id: r.holdId, releaseAt: r.releaseAt });
          setSigned((s) => ({ ...s, S: 'required' }));
          setPhase('held');
          return;
        }
        setSigned((s) => ({ ...s, S: 'signed' }));
        await finish(r);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403 && (e.body as { checks?: Check[] })?.checks) {
          const body = e.body as { checks: Check[]; summary: string[] };
          setPreview({ summary: body.summary, checks: body.checks, decision: 'refused', holdSeconds: 0 });
          setPhase('refused');
          return;
        }
        throw e;
      }
    } catch (e) {
      setError(errorText(e));
      setPhase('error');
    }
  };

  const withCard = async (words: string) => {
    if (!prepared) return;
    setPhase('signing');
    try {
      const sigs: FactorSignature[] = [];
      if (mode === 'passkey+card') sigs.push(await signPasskey());
      const data = await cardSign(words, prepared.hash);
      sigs.push({ factor: Factor.CARD, data });
      setSigned((s) => ({ ...s, C: 'signed' }));
      await finish(await svc.send(withSignatures(prepared.op, sigs)));
    } catch (e) {
      setError(errorText(e));
      setPhase('error');
    }
  };

  const decision = preview?.decision;
  const confirmLabel =
    mode === 'card'
      ? 'Sign with my recovery card'
      : mode === 'passkey+card'
        ? 'Confirm with Face ID and my card'
        : mode === 'coffre' && decision === 'held'
          ? 'Schedule with Face ID'
          : 'Confirm with Face ID';

  return (
    <Sheet onClose={onClose} label={title}>
      <div className="signflow">
        <div className="signflow-head">
          <Seal
            states={sealStates}
            size={132}
            center={
              <span className="seal-count">
                {Object.values(signed).filter((s) => s === 'signed').length}/{required.length}
              </span>
            }
          />
          <div>
            <h2>{title}</h2>
            <p className="muted small">
              {mode === 'passkey' && 'Face ID alone — within your daily limit.'}
              {mode === 'coffre' && 'Your vault needs two keys: Face ID + Swissquote.'}
              {mode === 'card' && 'Your recovery card alone.'}
              {mode === 'passkey+card' && 'Face ID + your card: Swissquote is not involved.'}
            </p>
          </div>
        </div>

        {phase === 'preparing' && <p className="muted">Preparing the operation…</p>}

        {summary.length > 0 && phase !== 'preparing' && (
          <div className="wysiwys">
            <span className="wysiwys-label">What you sign</span>
            {summary.map((l) => (
              <p key={l}>{l}</p>
            ))}
            <span className="muted small">Network fee: paid by Swissquote</span>
          </div>
        )}

        {note}

        {preview && mode === 'coffre' && phase !== 'preparing' && <Checks checks={preview.checks} />}

        {phase === 'review' && (
          <>
            {mode === 'coffre' && decision === 'refused' ? (
              <Notice kind="danger" title="Swissquote will not co-sign this">
                See the checks above.
              </Notice>
            ) : (
              <Button onClick={() => void confirm()}>{confirmLabel}</Button>
            )}
            {mode === 'coffre' && decision === 'refused' && allowCardOverride && <Override onUse={() => setMode('passkey+card')} ack={ack} setAck={setAck} />}
            <Button kind="ghost" onClick={onClose}>
              Cancel
            </Button>
          </>
        )}

        {phase === 'card' && <CardEntry expected={wallet?.card} onWords={(w) => void withCard(w)} onCancel={() => setPhase('review')} />}

        {phase === 'signing' && <p className="muted">Signing and submitting…</p>}

        {phase === 'held' && hold && (
          <>
            <Notice kind="warning" title="Scheduled, not sent yet">
              First large transfer to this recipient: it executes in <WallCountdown until={hold.releaseAt} /> (24 hours in production) unless you
              cancel. Alerts went to your e-mail and phone.
            </Notice>
            <Button
              kind="secondary"
              onClick={async () => {
                await svc.cancelHold(hold.id);
                app.toast('Scheduled transfer cancelled', 'success');
                onClose();
              }}
            >
              Cancel this transfer
            </Button>
            <Button kind="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        )}

        {phase === 'refused' && (
          <>
            <Notice kind="danger" title="Swissquote refused to co-sign">
              Nothing was sent. Your Face ID signature alone cannot move vault funds.
            </Notice>
            {allowCardOverride && <Override onUse={() => setMode('passkey+card')} ack={ack} setAck={setAck} afterRefusal onConfirm={() => setPhase('card')} />}
            <Button kind="ghost" onClick={onClose}>
              Close
            </Button>
          </>
        )}

        {phase === 'done' && result && (
          <>
            <Notice kind="success" title="Done">
              Executed on-chain <TxLink hash={result.txHash} />. You paid no network fee
              {result.gasPaidBySwissquoteWei ? ` (Swissquote paid ${(Number(result.gasPaidBySwissquoteWei) / 1e18).toFixed(6)} ETH)` : ''}.
            </Notice>
            <Button onClick={onClose}>Close</Button>
          </>
        )}

        {phase === 'error' && (
          <>
            <Notice kind="danger" title="Not executed">
              {error}
            </Notice>
            <Button kind="secondary" onClick={onClose}>
              Close
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}

function Override({
  onUse,
  ack,
  setAck,
  afterRefusal,
  onConfirm,
}: {
  onUse: () => void;
  ack: boolean;
  setAck: (b: boolean) => void;
  afterRefusal?: boolean;
  onConfirm?: () => void;
}) {
  return (
    <details className="override">
      <summary>It is my money: do it anyway with my card</summary>
      <p className="small">
        Self-custody means Swissquote cannot block you: Face ID + your recovery card is enough on-chain. Swissquote advises against this
        operation; you take full responsibility.
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand the risk
      </label>
      <Button
        kind="danger"
        disabled={!ack}
        onClick={() => {
          onUse();
          if (afterRefusal) onConfirm?.();
        }}
      >
        Continue with Face ID + card
      </Button>
    </details>
  );
}
