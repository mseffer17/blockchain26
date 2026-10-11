import { useState } from 'react';
import { encodeFunctionData, erc20Abi } from 'viem';
import { NonceLane, accountCall, formatUsdc, parseUsdc, shortAddress } from '@rutli/sdk';
import { useApp } from '../lib/app';
import { prepareOp } from '../lib/ops';
import { go } from '../lib/route';
import { SignFlow } from '../components/flows';
import { Button, Field, Header, Money, Notice, TxLink, errorText } from '../components/ui';

export function Bank() {
  const app = useApp();
  const { profile, wallet, svc, cfg } = app;
  const [amount, setAmount] = useState('5000');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ txHash: string; travelRule: string }>();
  const [error, setError] = useState<string>();
  const [backAmount, setBackAmount] = useState('100');
  const [backFlow, setBackFlow] = useState<bigint>();
  const [ext, setExt] = useState('');
  const [extResult, setExtResult] = useState<string>();
  if (!profile || !wallet) return null;
  const custodialUsdc = BigInt(profile.custodial.usdc);

  const moveToWallet = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const r = await svc.toWallet(parseUsdc(amount));
      setResult(r);
      app.toast(`${amount} USDC arrived in your wallet`, 'success');
      void app.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  let back = 0n;
  try {
    back = parseUsdc(backAmount);
  } catch {
    back = 0n;
  }
  const backDaily = back > 0n && back <= wallet.allowance.remaining && wallet.frozenUntil <= wallet.chainTime;

  return (
    <div className="screen bank">
      <Header title="Swissquote account" back={() => go('/')} />
      <section className="bank-balance">
        <span className="muted small">Held by Swissquote for you (custody)</span>
        <Money value={custodialUsdc} size="l" />
        <span className="muted small">and CHF {Number(profile.custodial.chf).toLocaleString('de-CH', { minimumFractionDigits: 2 })}</span>
      </section>

      <section className="panel">
        <h2>Move to my wallet</h2>
        <Field label="Amount (USDC)">
          <input className="input amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Button busy={busy} onClick={() => void moveToWallet()}>
          Move to my wallet now
        </Button>
        {error && <Notice kind="danger">{error}</Notice>}
        {result && (
          <Notice kind="success" title="Sent instantly">
            {result.travelRule} <TxLink hash={result.txHash} />
          </Notice>
        )}
      </section>

      <section className="panel">
        <h2>Send back to Swissquote</h2>
        <p className="muted small">To sell or keep in custody. Credited as soon as it lands: the origin is your own verified wallet.</p>
        <div className="row">
          <input className="input amount" inputMode="decimal" value={backAmount} onChange={(e) => setBackAmount(e.target.value)} />
          <Button wide={false} disabled={back <= 0n || back > wallet.usdc} onClick={() => setBackFlow(back)}>
            Send
          </Button>
        </div>
      </section>

      <section className="panel travel-rule">
        <h2>Travel Rule</h2>
        {profile.wallet?.ownership ? (
          <p>
            This wallet was verified as yours on {new Date(profile.wallet.ownership.verifiedAt).toLocaleDateString('de-CH')} by your passkey’s
            signature, bound to the wallet address. Transfers with your Swissquote account need no further check.
          </p>
        ) : (
          <p>Not verified.</p>
        )}
        <details>
          <summary>Compare: withdrawing to any other wallet today</summary>
          <Field label="External address">
            <input className="input mono" placeholder="0x…" value={ext} onChange={(e) => setExt(e.target.value.trim())} />
          </Field>
          <Button
            kind="secondary"
            onClick={async () => {
              try {
                await svc.toExternal(ext, 1_000_000n);
                setExtResult('Sent');
              } catch (e) {
                setExtResult(errorText(e));
              }
            }}
          >
            Try to withdraw 1 USDC
          </Button>
          {extResult && <Notice kind="warning">{extResult}</Notice>}
        </details>
        <Credential />
      </section>

      <section className="panel">
        <h2>Recent bank transfers</h2>
        <ul className="plain-list">
          {profile.transfers.slice(0, 6).map((t) => (
            <li key={t.id}>
              <span>
                {t.direction === 'to-wallet' ? 'To my wallet' : t.direction === 'from-wallet' ? 'From my wallet' : `Blocked: ${shortAddress(t.counterparty)}`}
              </span>
              <span>{formatUsdc(BigInt(t.amount))}</span>
            </li>
          ))}
        </ul>
      </section>

      {backFlow !== undefined && (
        <SignFlow
          title={`Send ${formatUsdc(backFlow)} USDC to Swissquote`}
          mode={backDaily ? 'passkey' : 'coffre'}
          build={() =>
            backDaily
              ? prepareOp(app, wallet.account, accountCall.spend(cfg.contracts.usdc, cfg.addresses.omnibus, backFlow), NonceLane.PORTE_MONNAIE)
              : prepareOp(
                  app,
                  wallet.account,
                  accountCall.execute(
                    cfg.contracts.usdc,
                    0n,
                    encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [cfg.addresses.omnibus, backFlow] }),
                  ),
                  NonceLane.COFFRE,
                  'coffre',
                )
          }
          onClose={() => setBackFlow(undefined)}
        />
      )}
    </div>
  );
}

/** Portable proof of ownership for OTHER institutions (SD-JWT VC: disclose only what is needed). */
function Credential() {
  const { svc } = useApp();
  const [cred, setCred] = useState<{ sdJwt: string; disclosures: Array<{ claim: string; disclosure: string }> }>();
  const [chosen, setChosen] = useState<Record<string, boolean>>({ given_name: true, family_name: true });
  const [verified, setVerified] = useState<Awaited<ReturnType<typeof svc.verifyCredential>>>();
  const [error, setError] = useState<string>();
  return (
    <details className="credential">
      <summary>Prove ownership to another bank or exchange</summary>
      <p className="small">
        Swissquote issues a verifiable credential (SD-JWT, the format of the Swiss e-ID wallet) stating that this self-hosted wallet belongs to
        a client it identified. You choose which personal details to reveal.
      </p>
      {!cred ? (
        <Button kind="secondary" onClick={async () => setCred(await svc.credential())}>
          Get my ownership credential
        </Button>
      ) : (
        <>
          {cred.disclosures.map((d) => (
            <label key={d.claim} className="checkbox">
              <input type="checkbox" checked={!!chosen[d.claim]} onChange={(e) => setChosen((c) => ({ ...c, [d.claim]: e.target.checked }))} /> Reveal{' '}
              {d.claim.replace('_', ' ')}
            </label>
          ))}
          <Button
            kind="secondary"
            onClick={async () => {
              setError(undefined);
              try {
                const jwt = cred.sdJwt.split('~')[0];
                const parts = cred.disclosures.filter((d) => chosen[d.claim]).map((d) => d.disclosure);
                setVerified(await svc.verifyCredential(`${jwt}~${parts.join('~')}~`));
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            Present to the other institution
          </Button>
          {error && <Notice kind="danger">{error}</Notice>}
          {verified && (
            <Notice kind="success" title="Verified by the receiving institution">
              Wallet {shortAddress(verified.wallet.address)} — {verified.onChainCheck}. Revealed:{' '}
              {Object.entries(verified.disclosed)
                .map(([k, v]) => `${k.replace('_', ' ')}: ${String(v)}`)
                .join(', ') || 'nothing'}
              . Hidden: {verified.hidden} claim(s).
            </Notice>
          )}
        </>
      )}
    </details>
  );
}
