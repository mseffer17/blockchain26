import { useMemo, useState } from 'react';
import { encodeFunctionData, erc20Abi, isAddress, getAddress, type Address } from 'viem';
import { NonceLane, accountCall, formatUsdc, parseUsdc } from '@rutli/sdk';
import { useApp } from '../lib/app';
import { contacts } from '../lib/contacts';
import { prepareOp } from '../lib/ops';
import { go } from '../lib/route';
import { SignFlow, type SignMode } from '../components/flows';
import { Button, Field, Header, Notice } from '../components/ui';

export function Send() {
  const app = useApp();
  const { cfg, wallet } = app;
  const [to, setTo] = useState('');
  const [amountText, setAmountText] = useState('');
  const [forceVault, setForceVault] = useState(false);
  const [useCard, setUseCard] = useState(false);
  const [flow, setFlow] = useState<{ mode: SignMode; to: Address; amount: bigint; daily: boolean }>();

  const amount = useMemo(() => {
    try {
      return amountText ? parseUsdc(amountText) : 0n;
    } catch {
      return -1n;
    }
  }, [amountText]);
  if (!wallet) return null;
  const frozen = wallet.frozenUntil > wallet.chainTime;
  const fitsDaily = amount > 0n && amount <= wallet.allowance.remaining && !frozen;
  const daily = fitsDaily && !forceVault && !useCard;
  const validTo = isAddress(to);
  const enough = amount > 0n && amount <= wallet.usdc;
  const mode: SignMode = daily ? 'passkey' : useCard ? 'passkey+card' : 'coffre';

  return (
    <div className="screen send">
      <Header title="Send USDC" back={() => go('/')} />
      <Field label="To">
        <input className="input mono" placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value.trim())} spellCheck={false} />
      </Field>
      <div className="contact-list">
        {contacts(cfg).map((c) => (
          <button key={c.address} type="button" className={`contact${to.toLowerCase() === c.address.toLowerCase() ? ' is-selected' : ''}`} onClick={() => setTo(c.address)}>
            <span className="contact-name">{c.name}</span>
            <span className="contact-note">{c.note}</span>
          </button>
        ))}
      </div>
      <Field label="Amount" hint={`Available: ${formatUsdc(wallet.usdc)} USDC`}>
        <div className="amount-input">
          <input className="input amount" inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
          <span>USDC</span>
        </div>
      </Field>

      {amount > 0n && (
        <div className={`route route-${daily ? 'daily' : 'vault'}`}>
          {daily ? (
            <>
              <strong>Face ID alone.</strong> Within today’s limit ({formatUsdc(wallet.allowance.remaining, { decimals: 0 })} USDC left).
            </>
          ) : useCard ? (
            <>
              <strong>Face ID + your card.</strong> Swissquote is not involved.
            </>
          ) : (
            <>
              <strong>From the vault: Face ID + Swissquote.</strong>{' '}
              {frozen ? 'Face-ID-only spending is frozen.' : !fitsDaily ? 'Above today’s Face ID limit.' : 'You chose the vault.'} Swissquote screens
              the recipient and simulates the transfer before co-signing.
            </>
          )}
        </div>
      )}
      <div className="options">
        {fitsDaily && (
          <label className="checkbox">
            <input type="checkbox" checked={forceVault} onChange={(e) => setForceVault(e.target.checked)} /> Pay from the vault instead
          </label>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={useCard} onChange={(e) => setUseCard(e.target.checked)} /> Use my recovery card instead of Swissquote
        </label>
      </div>
      {amount < 0n && <Notice kind="danger">Enter an amount like 120 or 120.50</Notice>}
      {amount > 0n && !enough && <Notice kind="danger">Not enough USDC in the wallet.</Notice>}
      <Button disabled={!validTo || !enough} onClick={() => setFlow({ mode, to: getAddress(to), amount, daily })}>
        Review
      </Button>

      {flow && (
        <SignFlow
          title={`Send ${formatUsdc(flow.amount)} USDC`}
          mode={flow.mode}
          build={() =>
            flow.daily
              ? prepareOp(app, wallet.account, accountCall.spend(cfg.contracts.usdc, flow.to, flow.amount), NonceLane.PORTE_MONNAIE)
              : prepareOp(
                  app,
                  wallet.account,
                  accountCall.execute(cfg.contracts.usdc, 0n, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [flow.to, flow.amount] })),
                  NonceLane.COFFRE,
                  'coffre',
                )
          }
          onClose={() => setFlow(undefined)}
          onDone={() => {
            setAmountText('');
          }}
        />
      )}
    </div>
  );
}
