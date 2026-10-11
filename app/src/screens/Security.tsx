import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  Factor,
  NonceLane,
  RADIOGRAPHY_ACTIONS,
  RADIOGRAPHY_ACTORS,
  accountCall,
  cardAccount,
  cardId,
  cardQrPayload,
  formatDuration,
  formatUsdc,
  generateCardMnemonic,
} from '@rutli/sdk';
import { useApp } from '../lib/app';
import { readPact } from '../lib/chain';
import { deviceSign, rememberDemoCard } from '../lib/device';
import { prepareOp, withSignatures } from '../lib/ops';
import { go } from '../lib/route';
import { IdentStep, Sheet, SignFlow, type SignMode } from '../components/flows';
import { Seal } from '../components/Seal';
import { Addr, Button, Countdown, Header, Notice, errorText, useChainCountdown } from '../components/ui';

type Action =
  | { kind: 'cancelRecovery'; mode: SignMode }
  | { kind: 'cancelExit'; mode: SignMode }
  | { kind: 'freeze' }
  | { kind: 'unfreeze' };

export function Security() {
  const app = useApp();
  const { wallet, pc } = app;
  const [pact, setPact] = useState<Awaited<ReturnType<typeof readPact>>>();
  const [action, setAction] = useState<Action>();
  const [rotateCard, setRotateCard] = useState(false);
  const [showMatrix, setShowMatrix] = useState(false);

  useEffect(() => {
    if (!wallet) return;
    void readPact(pc, wallet.account).then(setPact);
  }, [wallet?.account, wallet?.securityEpoch, wallet?.sovereign, pc]);

  const frozenLeft = useChainCountdown(wallet?.frozenUntil ?? 0);
  if (!wallet) return null;
  const a = pact?.answers;
  const can = (actor: string, act: string) => !!a?.[actor]?.[act];
  const delayR = formatDuration(wallet.recoveryDelay);
  const delayE = formatDuration(wallet.exitDelay);
  const daily = formatUsdc(wallet.allowance.limit, { decimals: 0 });

  const statements: Array<{ who: string; yes: boolean; text: string; tone: 'client' | 'institution' }> = a
    ? [
        {
          who: 'Swissquote alone',
          yes: can('S', 'spend') || can('S', 'execute'),
          text: can('S', 'execute') ? 'can move your money' : 'cannot move your money. It can only freeze Face-ID spending.',
          tone: 'institution',
        },
        {
          who: 'Swissquote + La Poste',
          yes: can('SG', 'spend') || can('SG', 'execute'),
          text:
            can('SG', 'execute') || can('SG', 'spend')
              ? 'can move your money'
              : `cannot move your money. Together they can only start a recovery that waits ${delayR} (7 days in production) and that you cancel with Face ID or your card.`,
          tone: 'institution',
        },
        { who: 'You + your card', yes: can('PC', 'execute'), text: 'can do everything, without Swissquote.', tone: 'client' },
        { who: 'You + Swissquote', yes: can('PS', 'execute'), text: 'can do everything, after Swissquote’s screening.', tone: 'client' },
        { who: 'Your card + Swissquote', yes: can('CS', 'rotatePasskey'), text: 'can only replace your passkey (lost phone, after video identification).', tone: 'client' },
        {
          who: 'Your card alone',
          yes: can('C', 'exit'),
          text: `can freeze, cancel a recovery, or start an exit that waits ${delayE} (30 days in production).`,
          tone: 'client',
        },
        { who: 'Your phone alone', yes: can('P', 'spend'), text: `can spend up to ${daily} USDC a day.`, tone: 'client' },
      ]
    : [];

  const buildAction = (x: Action) => {
    const call =
      x.kind === 'cancelRecovery'
        ? accountCall.cancelRecovery()
        : x.kind === 'cancelExit'
          ? accountCall.cancelExit()
          : x.kind === 'freeze'
            ? accountCall.freeze()
            : accountCall.unfreeze();
    return prepareOp(app, wallet.account, call, NonceLane.SECURITY, 'security');
  };

  return (
    <div className="screen security">
      <Header title="Security" back={() => go('/')} />
      <div className="security-hero">
        <Seal
          size={190}
          states={{
            P: 'signed',
            C: wallet.card !== '0x0000000000000000000000000000000000000000' ? 'signed' : 'idle',
            S: wallet.cosigner !== '0x0000000000000000000000000000000000000000' ? 'signed' : 'idle',
            G: wallet.guardian !== '0x0000000000000000000000000000000000000000' ? 'signed' : 'idle',
          }}
          center={<span className="seal-count">{wallet.sovereign ? 'sovereign' : 'your pact'}</span>}
        />
        <p className="seal-legend">
          <span className="legend-client">your keys</span>
          <span className="legend-inst">institutions’ keys</span>
        </p>
      </div>

      {wallet.pendingRecovery.executeAfter > 0 && (
        <section className="panel panel-danger">
          <h2>Recovery in progress</h2>
          <p>
            Swissquote and La Poste confirmed a request to replace your passkey and your card. It completes in{' '}
            <Countdown target={wallet.pendingRecovery.executeAfter} />. If it was not you, cancel it now.
          </p>
          <Button kind="danger" onClick={() => setAction({ kind: 'cancelRecovery', mode: 'passkey' })}>
            Cancel the recovery with Face ID
          </Button>
          <Button kind="secondary" onClick={() => setAction({ kind: 'cancelRecovery', mode: 'card' })}>
            Cancel with my card
          </Button>
        </section>
      )}
      {wallet.pendingExit.executeAfter > 0 && (
        <section className="panel panel-danger">
          <h2>Exit in progress</h2>
          <p>
            Your recovery card started an exit. In <Countdown target={wallet.pendingExit.executeAfter} /> the card alone will control the wallet
            and Swissquote will be removed. If the card was stolen, cancel now.
          </p>
          <Button kind="danger" onClick={() => setAction({ kind: 'cancelExit', mode: 'passkey' })}>
            Cancel the exit with Face ID
          </Button>
        </section>
      )}

      <section className="panel radiography">
        <h2>Who can move your money?</h2>
        {!a && <p className="muted">Asking the contract…</p>}
        <ul className="statements">
          {statements.map((s) => (
            <li key={s.who} className={`statement statement-${s.tone}`}>
              <strong>{s.who}</strong> {s.text}
            </li>
          ))}
        </ul>
        {pact && (
          <p className="provenance">
            Read live from your wallet contract (<code>canAuthorize</code>) at block {pact.block.toString()}. Not a promise: code that nobody,
            Swissquote included, can change.
          </p>
        )}
        <button type="button" className="link" onClick={() => setShowMatrix((x) => !x)}>
          {showMatrix ? 'Hide' : 'Show'} the full rule table
        </button>
        {showMatrix && a && (
          <div className="matrix-wrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th scope="col">Who</th>
                  {RADIOGRAPHY_ACTIONS.map((x) => (
                    <th key={x.id} scope="col">
                      {x.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {RADIOGRAPHY_ACTORS.map((actor) => (
                  <tr key={actor.id} className={actor.who === 'institutions' ? 'row-inst' : ''}>
                    <th scope="row">{actor.label}</th>
                    {RADIOGRAPHY_ACTIONS.map((x) => {
                      const ok = a[actor.id]?.[x.id];
                      return (
                        <td key={x.id} className={ok ? 'yes' : 'no'}>
                          {ok ? (x.delay === 'recovery' ? `after ${delayR}` : x.delay === 'exit' ? `after ${delayE}` : 'yes') : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Freeze</h2>
        {frozenLeft > 0 ? (
          <>
            <p>
              Face-ID-only spending is frozen for <Countdown target={wallet.frozenUntil} />. Rotating the passkey from a new phone lifts it.
            </p>
            <Button kind="secondary" onClick={() => setAction({ kind: 'unfreeze' })}>
              Unfreeze with Face ID and my card
            </Button>
          </>
        ) : (
          <>
            <p className="muted small">Blocking is easy, unblocking is hard: your card, Swissquote or La Poste can freeze alone; only you can unfreeze early.</p>
            <Button kind="secondary" onClick={() => setAction({ kind: 'freeze' })}>
              Freeze Face-ID spending with my card
            </Button>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Your keys</h2>
        <dl className="keys">
          <dt>Passkey</dt>
          <dd>This phone (P-256, secure chip)</dd>
          <dt>Recovery card</dt>
          <dd>
            Card {cardId(wallet.card)} <Addr value={wallet.card} />
          </dd>
          <dt>Swissquote co-signer</dt>
          <dd>{wallet.cosigner === '0x0000000000000000000000000000000000000000' ? 'removed' : <Addr value={wallet.cosigner} />}</dd>
          <dt>La Poste guardian</dt>
          <dd>{wallet.guardian === '0x0000000000000000000000000000000000000000' ? 'removed' : <Addr value={wallet.guardian} />}</dd>
          <dt>Wallet contract</dt>
          <dd>
            <Addr value={wallet.account} />
          </dd>
        </dl>
        {!wallet.sovereign && (
          <Button kind="secondary" onClick={() => setRotateCard(true)}>
            I lost my recovery card
          </Button>
        )}
        <a className="exit-link" href="http://localhost:5174" target="_blank" rel="noreferrer">
          If Swissquote ever disappears: the open-source exit app works with your card alone.
        </a>
      </section>

      {action && (
        <SignFlow
          title={
            action.kind === 'cancelRecovery'
              ? 'Cancel the recovery'
              : action.kind === 'cancelExit'
                ? 'Cancel the exit'
                : action.kind === 'freeze'
                  ? 'Freeze Face-ID spending'
                  : 'Lift the freeze'
          }
          mode={action.kind === 'freeze' ? 'card' : action.kind === 'unfreeze' ? 'passkey+card' : action.mode}
          build={() => buildAction(action)}
          onClose={() => setAction(undefined)}
          onDone={() => app.toast('Done', 'success')}
          allowCardOverride={false}
        />
      )}
      {rotateCard && <RotateCard onClose={() => setRotateCard(false)} />}
    </div>
  );
}

/** Lost card: Face ID + video identification → Swissquote co-signs the new card. */
function RotateCard({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const { wallet, passkey, svc } = app;
  const [token, setToken] = useState<string>();
  const [words] = useState(() => generateCardMnemonic());
  const [qr, setQr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  useEffect(() => {
    void QRCode.toDataURL(cardQrPayload(words), { margin: 1, width: 180 }).then(setQr);
  }, [words]);
  if (!wallet || !passkey) return null;
  const newCard = cardAccount(words).address;

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { op, hash } = await prepareOp(app, wallet.account, accountCall.rotateCard(newCard), NonceLane.SECURITY, 'security');
      const p = await deviceSign(passkey, hash);
      const r = await svc.rotateCard(withSignatures(op, [{ factor: Factor.PASSKEY, data: p }]), token!);
      if (!r.success) throw new Error(r.error ?? 'failed');
      rememberDemoCard({ address: newCard, words, createdAt: Date.now() });
      setDone(true);
      void app.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={onClose} label="Replace my recovery card">
      <div className="signflow">
        <h2>Replace your recovery card</h2>
        {!token && <IdentStep purpose="rotate-card" onToken={setToken} />}
        {token && !done && (
          <>
            <p>Print your new card. The old one stops working as soon as you confirm.</p>
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
            {error && <Notice kind="danger">{error}</Notice>}
            <Button busy={busy} onClick={() => void submit()}>
              Confirm with Face ID
            </Button>
          </>
        )}
        {done && (
          <>
            <Notice kind="success" title="New card active">
              Your old card is void. Face ID + Swissquote replaced it after the video identification.
            </Notice>
            <Button onClick={onClose}>Close</Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
