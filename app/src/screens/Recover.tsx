import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Factor,
  NonceLane,
  accountCall,
  cardAccount,
  cardId,
  cardQrPayload,
  cardSign,
  formatDuration,
  generateCardMnemonic,
} from '@rutli/sdk';
import { useApp } from '../lib/app';
import { DEVICE_LABEL, createDevicePasskey, platformAvailable, rememberDemoCard, setPendingPasskey, type DevicePasskey } from '../lib/device';
import { prepareOp, withSignatures } from '../lib/ops';
import { CardEntry, IdentStep } from '../components/flows';
import { Seal } from '../components/Seal';
import { Button, Countdown, Field, Notice, errorText, useChainCountdown } from '../components/ui';

type Path = 'menu' | 'card' | 'guardian' | 'hotline';

export function Recover() {
  const [path, setPath] = useState<Path>('menu');
  return (
    <div className="screen recover">
      {path === 'menu' && (
        <>
          <h1 className="display">This phone is not linked to your wallet yet</h1>
          <p className="lead">Your wallet and your money are safe on-chain. Choose what happened.</p>
          <div className="choices">
            <button type="button" className="choice" onClick={() => setPath('card')}>
              <strong>New phone, I have my recovery card</strong>
              <span>Card + video identification. Immediate.</span>
            </button>
            <button type="button" className="choice" onClick={() => setPath('guardian')}>
              <strong>I lost my phone and my card</strong>
              <span>Video identification + a letter from La Poste. Public delay that you can cancel.</span>
            </button>
            <button type="button" className="choice choice-danger" onClick={() => setPath('hotline')}>
              <strong>My phone was stolen: freeze now</strong>
              <span>Blocks Face-ID spending in seconds. Nothing can be moved or unlocked by this.</span>
            </button>
          </div>
        </>
      )}
      {path === 'card' && <WithCard onBack={() => setPath('menu')} />}
      {path === 'guardian' && <WithGuardian onBack={() => setPath('menu')} />}
      {path === 'hotline' && <Hotline onBack={() => setPath('menu')} />}
    </div>
  );
}

function NewPasskey({ onCreated }: { onCreated: (p: DevicePasskey) => void }) {
  const { profile } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [hasPlatform, setHasPlatform] = useState<boolean | null>(null);
  useEffect(() => {
    void platformAvailable().then(setHasPlatform);
  }, []);
  const create = async (mode: 'platform' | 'soft') => {
    setBusy(true);
    try {
      onCreated(await createDevicePasskey(mode, profile?.email ?? 'claire'));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };
  return (
    <>
      <p>Create a new passkey on {DEVICE_LABEL}.</p>
      {error && <Notice kind="danger">{error}</Notice>}
      <Button busy={busy} disabled={hasPlatform === false} onClick={() => void create('platform')}>
        Create with Face ID / Touch ID
      </Button>
      <Button kind="secondary" busy={busy} onClick={() => void create('soft')}>
        Use the demo authenticator
      </Button>
    </>
  );
}

/** Lost phone, card at home: CARD signs the new passkey, Swissquote co-signs after video identification. */
function WithCard({ onBack }: { onBack: () => void }) {
  const app = useApp();
  const { wallet, svc } = app;
  const [pk, setPk] = useState<DevicePasskey>();
  const [words, setWords] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!wallet) return null;

  const finish = async (token: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const { op, hash } = await prepareOp(app, wallet.account, accountCall.rotatePasskey(pk!.x, pk!.y), NonceLane.SECURITY, 'security');
      const c = await cardSign(words!, hash);
      const r = await svc.rotatePasskey(withSignatures(op, [{ factor: Factor.CARD, data: c }]), token);
      if (!r.success) throw new Error(r.error ?? 'failed');
      await app.refresh();
      app.setPasskey(pk);
      app.toast('This phone now controls your wallet', 'success');
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="display">New phone</h1>
      <Seal states={{ C: words ? 'signed' : 'required', S: 'required' }} size={140} />
      {!pk && <NewPasskey onCreated={setPk} />}
      {pk && !words && <CardEntry expected={wallet.card} onWords={setWords} onCancel={onBack} />}
      {pk && words && !busy && <IdentStep purpose="rotate-passkey" onToken={(t) => void finish(t)} />}
      {busy && <p className="muted">Swissquote verifies the card signature and the identification, then co-signs…</p>}
      {error && <Notice kind="danger">{error}</Notice>}
      <Button kind="ghost" onClick={onBack}>
        Back
      </Button>
    </>
  );
}

/** Lost everything: Swissquote (video) + La Poste (letter) start a delayed, cancellable recovery. */
function WithGuardian({ onBack }: { onBack: () => void }) {
  const app = useApp();
  const { svc, cfg } = app;
  const [pk, setPk] = useState<DevicePasskey>();
  const [words] = useState(() => generateCardMnemonic());
  const [qr, setQr] = useState<string>();
  const [printed, setPrinted] = useState(false);
  const [kase, setKase] = useState<{ caseId: string; posteCaseId: string; letterSentTo: string; caseRef: string }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    void QRCode.toDataURL(cardQrPayload(words), { margin: 1, width: 180 }).then(setQr);
  }, [words]);
  const newCard = cardAccount(words).address;

  const start = async (token: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await svc.guardianStart({ newPasskeyX: pk!.x, newPasskeyY: pk!.y, newCard, identToken: token, reason: 'LOST_ALL' });
      setKase(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (!kase) return;
    setBusy(true);
    setError(undefined);
    try {
      await svc.posteVerify(kase.posteCaseId, code);
      setPendingPasskey(pk);
      rememberDemoCard({ address: newCard, words, createdAt: Date.now() });
      await svc.guardianSubmit(kase.caseId);
      app.toast('Recovery started on-chain', 'success');
      void app.refresh();
    } catch (e) {
      setPendingPasskey(undefined);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="display">Lost phone and card</h1>
      <Seal states={{ S: kase ? 'signed' : 'required', G: 'required' }} size={140} />
      {!pk && <NewPasskey onCreated={setPk} />}
      {pk && !printed && (
        <>
          <p>Print your new recovery card first.</p>
          <div className="paper-card compact">
            <div className="paper-card-head">
              <span className="paper-card-brand">Rütli recovery card</span>
              <span className="paper-card-id">Card {cardId(newCard)}</span>
            </div>
            <div className="paper-card-body">
              {qr && <img src={qr} alt="QR code of the new card" className="paper-card-qr" />}
              <ol className="paper-card-words">
                {words.split(' ').map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ol>
            </div>
          </div>
          <Button onClick={() => setPrinted(true)}>I have printed it</Button>
        </>
      )}
      {pk && printed && !kase && (
        <IdentStep
          purpose="guardian-recovery"
          onToken={(t) => void start(t)}
          intro={<p className="muted">Swissquote’s check: a certified agent compares your face with your account-opening photo.</p>}
        />
      )}
      {kase && (
        <>
          <Notice kind="info" title="La Poste sent you a registered letter">
            To {kase.letterSentTo} (case {kase.caseRef}). Only someone with access to your mailbox can read the code. A phone or e-mail thief cannot.
          </Notice>
          <a className="link" href="/#/mailbox" target="_blank" rel="noreferrer">
            Open Claire’s mailbox (demo)
          </a>
          <Field label="Code from the letter">
            <input className="input mono" placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
          </Field>
          <Button busy={busy} disabled={code.trim().length < 8} onClick={() => void submitCode()}>
            Confirm and start the recovery
          </Button>
          <p className="muted small">
            Then a public delay of {formatDuration(cfg.params.recoveryDelay)} (7 days in production) runs; your old phone and your old card are
            alerted and can cancel.
          </p>
        </>
      )}
      {busy && !kase && <p className="muted">Opening the case with La Poste…</p>}
      {error && <Notice kind="danger">{error}</Notice>}
      <Button kind="ghost" onClick={onBack}>
        Back
      </Button>
    </>
  );
}

/** Theft hotline (e.g. from a friend's phone): a low bar on purpose — it can only block. */
function Hotline({ onBack }: { onBack: () => void }) {
  const app = useApp();
  const [birth, setBirth] = useState('1968-04-12');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number>();
  const [error, setError] = useState<string>();
  return (
    <>
      <h1 className="display">Freeze my wallet</h1>
      <p className="lead">Same as calling Swissquote’s hotline. Freezing only blocks: it cannot move or unlock anything, so the check is light.</p>
      <Field label="Date of birth">
        <input className="input" type="date" value={birth} onChange={(e) => setBirth(e.target.value)} />
      </Field>
      {error && <Notice kind="danger">{error}</Notice>}
      {done ? (
        <Notice kind="success" title="Frozen">
          Face-ID-only spending is blocked until {new Date(done * 1000).toLocaleString('de-CH')}. Swissquote will co-sign nothing for the stolen
          phone. Next: link a new phone with your card.
        </Notice>
      ) : (
        <Button
          kind="danger"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await app.svc.reportTheft(birth);
              setDone(r.frozenUntil);
              void app.refresh();
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Report stolen and freeze
        </Button>
      )}
      <Button kind="ghost" onClick={onBack}>
        Back
      </Button>
    </>
  );
}

/** This device created the passkey of a pending S+G recovery. */
export function Recovering() {
  const app = useApp();
  const { wallet, svc } = app;
  const left = useChainCountdown(wallet?.pendingRecovery.executeAfter ?? 0);
  const [busy, setBusy] = useState(false);
  if (!wallet) return null;
  return (
    <div className="screen recover">
      <h1 className="display">Recovery in progress</h1>
      <Seal states={{ S: 'signed', G: 'signed' }} size={160} center={<span className="seal-count">waiting</span>} />
      <p className="lead">
        Swissquote and La Poste confirmed your identity. Your new passkey takes over in <Countdown target={wallet.pendingRecovery.executeAfter} />{' '}
        (7 days in production).
      </p>
      <p className="muted">
        During this delay, your old phone and your old card received alerts and can cancel. That is what stops a thief who fooled two institutions.
      </p>
      {left === 0 && (
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await svc.finalize(wallet.account, 'recovery');
              void app.refresh();
            } catch (e) {
              app.toast(errorText(e), 'danger');
            } finally {
              setBusy(false);
            }
          }}
        >
          Complete the recovery
        </Button>
      )}
    </div>
  );
}

/** The passkey of this phone was replaced from another device (e.g. Mallory holding the stolen phone). */
export function Removed() {
  const app = useApp();
  return (
    <div className="screen recover removed">
      <h1 className="display">This phone no longer controls the wallet</h1>
      <Seal states={{ P: 'refused' }} size={150} center={<span className="seal-count">removed</span>} />
      <p className="lead">
        Its passkey was replaced from another device, with the recovery card and a video identification. Face ID on this phone can no longer sign
        anything.
      </p>
      {app.holder === 'mallory' && (
        <Notice kind="danger" title="Mallory’s haul">
          The daily wallet, at most. Everything else needed a key she never had.
        </Notice>
      )}
      <Button
        kind="secondary"
        onClick={() => {
          app.setPasskey(undefined);
        }}
      >
        Set up this phone again
      </Button>
    </div>
  );
}
