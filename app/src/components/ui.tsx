import { useEffect, useState, type ReactNode } from 'react';
import { formatDuration, formatUsdc, shortAddress } from '@rutli/sdk';
import { useApp } from '../lib/app';
import { chainNow } from '../lib/chain';

export function Money({ value, unit = 'USDC', size = 'm' }: { value: bigint; unit?: string; size?: 's' | 'm' | 'l' | 'xl' }) {
  const [int, frac] = formatUsdc(value).split('.');
  return (
    <span className={`money money-${size}`}>
      <span className="money-int">{int}</span>
      <span className="money-frac">.{frac}</span>
      {unit && <span className="money-unit">{unit}</span>}
    </span>
  );
}

export function Addr({ value, full = false }: { value: string; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="addr"
      title={value}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {full ? value : shortAddress(value)}
      <span className="addr-hint">{copied ? 'copied' : 'copy'}</span>
    </button>
  );
}

/** Seconds left until a chain timestamp (uses the chain's clock, which the demo can fast-forward). */
export function useChainCountdown(target: number): number {
  const { wallet } = useApp();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!wallet || !target) return 0;
  return Math.max(0, target - chainNow(wallet));
}

export function Countdown({ target, done = 'ready' }: { target: number; done?: string }) {
  const left = useChainCountdown(target);
  return <span className="countdown">{left > 0 ? formatDuration(left) : done}</span>;
}

export function WallCountdown({ until }: { until: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor((until - Date.now()) / 1000));
  return <span className="countdown">{left > 0 ? formatDuration(left) : 'now'}</span>;
}

export function Button({
  children,
  onClick,
  kind = 'primary',
  disabled,
  busy,
  type = 'button',
  wide = true,
}: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'ink';
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
  wide?: boolean;
}) {
  return (
    <button type={type} className={`btn btn-${kind}${wide ? ' btn-wide' : ''}${busy ? ' is-busy' : ''}`} onClick={onClick} disabled={disabled || busy}>
      {busy ? <span className="spinner" aria-hidden /> : null}
      <span>{children}</span>
    </button>
  );
}

export function Notice({ kind = 'info', title, children }: { kind?: 'info' | 'warning' | 'danger' | 'success'; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      {title && <div className="notice-title">{title}</div>}
      {children && <div className="notice-body">{children}</div>}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Header({ title, back, right }: { title: string; back?: () => void; right?: ReactNode }) {
  return (
    <header className="screen-header">
      {back ? (
        <button type="button" className="icon-btn" onClick={back} aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <span />
      )}
      <h1>{title}</h1>
      <span className="screen-header-right">{right}</span>
    </header>
  );
}

export function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as Error).message);
  return String(e);
}

export function TxLink({ hash }: { hash?: string }) {
  const { cfg } = useApp();
  if (!hash) return null;
  const url = cfg.explorerUrl ? `${cfg.explorerUrl}/tx/${hash}` : undefined;
  return url ? (
    <a className="tx" href={url} target="_blank" rel="noreferrer">
      tx {shortAddress(hash)}
    </a>
  ) : (
    <span className="tx" title={hash}>
      tx {shortAddress(hash)}
    </span>
  );
}
