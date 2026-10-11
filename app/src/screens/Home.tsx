import { useEffect, useState } from 'react';
import { formatUsdc, nameOf } from '@rutli/sdk';
import { useApp } from '../lib/app';
import { readActivity, type ActivityItem } from '../lib/chain';
import { go } from '../lib/route';
import type { Hold } from '../lib/services';
import { Countdown, Money, Notice, WallCountdown, useChainCountdown } from '../components/ui';

export function Home() {
  const app = useApp();
  const { wallet, cfg, pc, svc, names, profile } = app;
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);

  useEffect(() => {
    if (!wallet) return;
    let stop = false;
    const load = async () => {
      try {
        const [a, h] = await Promise.all([readActivity(pc, cfg, wallet.account), svc.holds().catch(() => [])]);
        if (!stop) {
          setActivity(a);
          setHolds(h.filter((x) => x.status === 'held'));
        }
      } catch {
        /* chain busy */
      }
    };
    void load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [wallet?.account, wallet?.blockNumber, pc, cfg, svc]);

  const frozenLeft = useChainCountdown(wallet?.frozenUntil ?? 0);
  if (!wallet) return null;
  const total = wallet.usdc + wallet.vaultAssets;
  const limit = wallet.allowance.limit;
  const remaining = wallet.allowance.remaining;
  const pct = limit > 0n ? Number((remaining * 1000n) / limit) / 10 : 0;

  return (
    <div className="screen home">
      <div className="hello">
        <span className="muted">Good day, {profile?.firstName}</span>
      </div>

      {wallet.pendingRecovery.executeAfter > 0 && (
        <button type="button" className="alert alert-danger" onClick={() => go('/security')}>
          <strong>A recovery of your wallet is in progress.</strong> It completes in <Countdown target={wallet.pendingRecovery.executeAfter} />. Not
          you? Cancel it with Face ID.
        </button>
      )}
      {wallet.pendingExit.executeAfter > 0 && (
        <button type="button" className="alert alert-danger" onClick={() => go('/security')}>
          <strong>Your recovery card started an exit.</strong> In <Countdown target={wallet.pendingExit.executeAfter} /> the card alone will
          control the wallet. Not you? Cancel it.
        </button>
      )}
      {frozenLeft > 0 && (
        <button type="button" className="alert alert-danger" onClick={() => go('/security')}>
          <strong>Face-ID spending is frozen</strong> (theft report). Vault operations still work with your card.
        </button>
      )}
      {wallet.sovereign && (
        <Notice kind="info" title="Sovereign mode">
          Swissquote and La Poste were removed after an exit. Your card has full control.
        </Notice>
      )}
      {holds.map((h) => (
        <div key={h.id} className="alert alert-warning">
          <strong>Scheduled:</strong> {h.summary.join('; ')} — executes in <WallCountdown until={h.releaseAt} />.{' '}
          <button
            type="button"
            className="link"
            onClick={async () => {
              await svc.cancelHold(h.id);
              app.toast('Scheduled transfer cancelled', 'success');
            }}
          >
            Cancel
          </button>
        </div>
      ))}

      <section className="balance" aria-label="Balance">
        <span className="balance-label">Total</span>
        <Money value={total} size="xl" />
        <span className="muted small">≈ CHF {formatUsdc((total * 79n) / 100n, { decimals: 0 })} (demo rate)</span>
      </section>

      <section className="compartment compartment-daily" aria-label="Daily Face ID allowance">
        <div className="compartment-row">
          <span className="compartment-title">Face ID alone, today</span>
          <span className="compartment-figure">
            {formatUsdc(remaining, { decimals: 0 })} <span className="muted">of {formatUsdc(limit, { decimals: 0 })} USDC</span>
          </span>
        </div>
        <div className="gauge" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="muted small">
          {wallet.allowance.windowEnd ? (
            <>
              Resets in <Countdown target={wallet.allowance.windowEnd} />
            </>
          ) : (
            'Full daily limit available'
          )}
        </span>
      </section>

      <section className="compartment compartment-vault" aria-label="Vault">
        <div className="compartment-row">
          <span className="compartment-title">Vault</span>
          <span className="vault-keys">2 keys</span>
        </div>
        <p>Above the daily limit, and for dApps: Face ID + Swissquote, or Face ID + your card.</p>
        {wallet.vaultAssets > 0n && (
          <div className="vault-position">
            <span>Helvetia Yield Vault</span>
            <Money value={wallet.vaultAssets} size="s" />
          </div>
        )}
      </section>

      <nav className="actions" aria-label="Actions">
        <button type="button" onClick={() => go('/send')}>
          <span className="action-icon">↗</span>Send
        </button>
        <button type="button" onClick={() => go('/receive')}>
          <span className="action-icon">↙</span>Receive
        </button>
        <button type="button" onClick={() => go('/bank')}>
          <span className="action-icon">⇄</span>Swissquote
        </button>
        <button type="button" onClick={() => go('/dapps')}>
          <span className="action-icon">◇</span>dApps
        </button>
      </nav>

      <section className="activity" aria-label="Activity">
        <h2>Activity</h2>
        {activity.length === 0 && <p className="muted">No movements yet. Move USDC from your Swissquote account to start.</p>}
        <ul>
          {activity.map((a) => (
            <li key={`${a.txHash}-${a.kind}`} className={`activity-item activity-${a.kind}`}>
              <span className="activity-what">
                {a.kind === 'in' ? 'From ' : 'To '}
                {nameOf(a.counterparty, names)}
              </span>
              <span className="activity-amount">
                {a.kind === 'in' ? '+' : '−'}
                {formatUsdc(a.amount)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
