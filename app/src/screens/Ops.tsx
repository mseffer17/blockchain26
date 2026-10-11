import { useEffect, useState, type ReactNode } from 'react';
import { formatUsdc, shortAddress } from '@rutli/sdk';
import { useApp } from '../lib/app';

type Tab = 'ident' | 'cosigner' | 'poste' | 'gas' | 'watch' | 'travel' | 'chain';

const TABS: Array<[Tab, string]> = [
  ['ident', 'Video identification'],
  ['cosigner', 'Swissquote co-signer'],
  ['poste', 'La Poste'],
  ['gas', 'Gas station'],
  ['watch', 'Watchtower'],
  ['travel', 'Travel Rule registry'],
  ['chain', 'Chain clock'],
];

function usePoll<T>(fn: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const [v, setV] = useState<T>();
  useEffect(() => {
    let stop = false;
    const load = () =>
      fn()
        .then((x) => !stop && setV(x))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return v;
}

const time = (t: number) => new Date(t).toLocaleTimeString('de-CH');

export function Ops() {
  const [tab, setTab] = useState<Tab>('ident');
  return (
    <div className="page ops">
      <header className="page-header">
        <h1>Back-office</h1>
        <p className="muted">The institutions’ side of the demo. Every panel is a separate mocked service with its own storage and keys.</p>
      </header>
      <nav className="ops-tabs" aria-label="Back-office sections">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === 'ident' && <Ident />}
      {tab === 'cosigner' && <Cosigner />}
      {tab === 'poste' && <Poste />}
      {tab === 'gas' && <Gas />}
      {tab === 'watch' && <Watch />}
      {tab === 'travel' && <Travel />}
      {tab === 'chain' && <ChainClock />}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="table-wrap">
      <table className="ops-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={head.length} className="muted">
                Nothing yet
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Ident() {
  const { svc } = useApp();
  const sessions = usePoll(() => svc.identSessions());
  return (
    <section>
      <p className="muted">Agent desk of the (mocked) FINMA-compliant identification provider. Auto-decision is on in the demo; agents can also decide here.</p>
      <div className="ident-queue">
        {(sessions ?? []).map((s) => {
          const x = s as { id: string; purpose: string; status: string; presentedPersona?: string; similarity?: number; reason?: string; createdAt: number };
          return (
            <article key={x.id} className={`ident-case ident-${x.status}`}>
              <div className="ident-faces">
                <figure>
                  <img src="/personas/claire.svg" alt="KYC reference photo" />
                  <figcaption>KYC photo (account opening)</figcaption>
                </figure>
                <figure>
                  <img src={`/personas/${x.presentedPersona ?? 'unknown'}.svg`} alt="Person in front of the camera" />
                  <figcaption>Live camera</figcaption>
                </figure>
              </div>
              <div>
                <strong>{x.purpose}</strong> at {time(x.createdAt)}
                <p>
                  Status: {x.status}
                  {x.similarity !== undefined ? `, similarity ${Math.round(x.similarity * 100)}%` : ''}
                </p>
                {x.reason && <p className="small">{x.reason}</p>}
                {x.status === 'in_review' && (
                  <div className="row">
                    <button type="button" className="btn btn-primary" onClick={() => void svc.identDecide(x.id, true)}>
                      Approve
                    </button>
                    <button type="button" className="btn btn-danger" onClick={() => void svc.identDecide(x.id, false)}>
                      Reject
                    </button>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Cosigner() {
  const { svc } = useApp();
  const o = usePoll(() => svc.opsCosigner()) as
    | {
        clients: Array<{ id: string; cosigner: string; account?: string; theftReportedAt?: number; addressBook: string[] }>;
        holds: Array<{ id: string; summary: string[]; status: string; releaseAt: number }>;
        decisions: Array<{ id: string; at: number; kind: string; decision: string; summary: string[]; checks: Array<{ label: string; status: string; detail?: string }> }>;
        guardianCases: Array<{ id: string; reason: string; status: string; letterSentTo: string; createdAt: number }>;
      }
    | undefined;
  return (
    <section className="stack-l">
      <h2>Clients</h2>
      <Table
        head={['Client', 'Per-client co-signer key', 'Wallet', 'Theft report', 'Known recipients']}
        rows={(o?.clients ?? []).map((c) => [c.id, shortAddress(c.cosigner), c.account ? shortAddress(c.account) : '—', c.theftReportedAt ? time(c.theftReportedAt) : '—', c.addressBook.length])}
      />
      <h2>Decisions</h2>
      <Table
        head={['Time', 'Operation', 'Decision', 'Checks']}
        rows={(o?.decisions ?? []).map((d) => [
          time(d.at),
          d.summary.join('; '),
          <span className={`tag tag-${d.decision}`}>{d.decision}</span>,
          d.checks
            .filter((c) => c.status !== 'pass' && c.status !== 'info')
            .map((c) => `${c.label}: ${c.detail ?? ''}`)
            .join(' | ') || 'all passed',
        ])}
      />
      <h2>Cool-off holds</h2>
      <Table head={['Operation', 'Status', 'Release']} rows={(o?.holds ?? []).map((h) => [h.summary.join('; '), h.status, time(h.releaseAt)])} />
      <h2>Recovery cases (with La Poste)</h2>
      <Table head={['Opened', 'Reason', 'Status', 'Letter to']} rows={(o?.guardianCases ?? []).map((g) => [time(g.createdAt), g.reason, g.status, g.letterSentTo])} />
    </section>
  );
}

function Poste() {
  const { svc } = useApp();
  const cases = usePoll(() => svc.posteCases());
  return (
    <section>
      <p className="muted">La Poste only signs the exact recovery of a case, after the code from the letter came back. The code itself is stored hashed.</p>
      <Table
        head={['Opened', 'Wallet', 'Reason', 'Status', 'Wrong codes']}
        rows={(cases ?? []).map((c) => {
          const x = c as { createdAt: number; account: string; reason: string; status: string; attempts: number };
          return [time(x.createdAt), shortAddress(x.account), x.reason, x.status, x.attempts];
        })}
      />
    </section>
  );
}

function Gas() {
  const { svc } = useApp();
  const s = usePoll(() => svc.gasStats()) as
    | {
        paymaster: string;
        paymasterDepositWei: string;
        bundler: string;
        bundlerBalanceWei: string;
        monthlyQuota: number;
        recentOps: Array<{ at: number; kind: string; sender: string; success?: boolean; gasCostWei?: string; error?: string }>;
      }
    | undefined;
  const eth = (w?: string) => (w ? (Number(w) / 1e18).toFixed(5) : '—');
  return (
    <section className="stack-l">
      <div className="kpis">
        <div>
          <span className="muted small">Paymaster deposit (Swissquote’s gas budget)</span>
          <strong>{eth(s?.paymasterDepositWei)} ETH</strong>
        </div>
        <div>
          <span className="muted small">Bundler balance</span>
          <strong>{eth(s?.bundlerBalanceWei)} ETH</strong>
        </div>
        <div>
          <span className="muted small">Free operations per wallet and month</span>
          <strong>{s?.monthlyQuota ?? '—'}</strong>
        </div>
      </div>
      <Table
        head={['Time', 'Wallet', 'Operation', 'Result', 'Gas paid (ETH)']}
        rows={(s?.recentOps ?? []).map((o) => [time(o.at), shortAddress(o.sender), o.kind, o.success ? 'ok' : o.error ?? 'reverted', eth(o.gasCostWei)])}
      />
    </section>
  );
}

function Watch() {
  const { svc } = useApp();
  const a = usePoll(() => svc.alerts());
  return (
    <section>
      <p className="muted">Open-source monitor: anyone can run it on public chain data. It turns every security event into alerts.</p>
      <Table
        head={['Time', 'Wallet', 'Event', 'Alert']}
        rows={(a?.alerts ?? []).map((x) => {
          const y = x as { at: number; account: string; event: string; title: string; level: string };
          return [time(y.at), shortAddress(y.account), y.event, <span className={`tag tag-${y.level}`}>{y.title}</span>];
        })}
      />
    </section>
  );
}

function Travel() {
  const { svc } = useApp();
  const clients = usePoll(() => svc.opsCore());
  return (
    <section className="stack-l">
      {(clients ?? []).map((c) => {
        const x = c as {
          id: string;
          name: string;
          wallet?: string;
          ownershipVerified: boolean;
          custodial: { usdc: string; chf: string };
          transfers: Array<{ id: string; at: number; direction: string; amount: string; counterparty: string; travelRule: string }>;
        };
        return (
          <div key={x.id} className="panel">
            <h2>{x.name}</h2>
            <p>
              Self-hosted wallet {x.wallet ? shortAddress(x.wallet) : '—'}: {x.ownershipVerified ? 'ownership verified by technical means' : 'not verified'}. Custodial
              balance {formatUsdc(BigInt(x.custodial.usdc))} USDC.
            </p>
            <Table
              head={['Time', 'Direction', 'Amount', 'Counterparty', 'Travel Rule record']}
              rows={x.transfers.map((t) => [time(t.at), t.direction, formatUsdc(BigInt(t.amount)), shortAddress(t.counterparty), t.travelRule])}
            />
          </div>
        );
      })}
    </section>
  );
}

function ChainClock() {
  const { pc, cfg } = useApp();
  const block = usePoll(() => pc.getBlock({ blockTag: 'latest' }));
  const [msg, setMsg] = useState<string>();
  const travel = async (seconds: number) => {
    await pc.request({ method: 'evm_increaseTime' as never, params: [seconds] as never });
    await pc.request({ method: 'evm_mine' as never, params: [] as never });
    setMsg(`Chain clock moved forward by ${seconds} s`);
  };
  if (cfg.network !== 'local') return <p className="muted">Time travel only exists on the local chain.</p>;
  return (
    <section className="stack-l">
      <p>
        Chain time: {block ? new Date(Number(block.timestamp) * 1000).toLocaleString('de-CH') : '…'} (block {block?.number.toString()})
      </p>
      <p className="muted">Demo delays are seconds; to show a 7-day or 30-day delay without waiting, move the local chain’s clock.</p>
      <div className="row">
        <button type="button" className="btn btn-secondary" onClick={() => void travel(60)}>
          +1 minute
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => void travel(cfg.params.recoveryDelay)}>
          + recovery delay
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => void travel(cfg.params.exitDelay)}>
          + exit delay
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => void travel(86400)}>
          +1 day (daily limit resets)
        </button>
      </div>
      {msg && <p className="ok-text">{msg}</p>}
    </section>
  );
}
