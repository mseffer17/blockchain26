import { useEffect, useState } from 'react';
import { encodeFunctionData, erc20Abi, maxUint256 } from 'viem';
import { NonceLane, accountCall, formatUsdc, helvetiaYieldVaultAbi, parseUsdc, scamAirdropAbi } from '@rutli/sdk';
import { useApp } from '../lib/app';
import { prepareOp } from '../lib/ops';
import { go } from '../lib/route';
import { SignFlow } from '../components/flows';
import { Button, Header, Money, Notice } from '../components/ui';

type Flow = { kind: 'deposit'; amount: bigint } | { kind: 'withdraw' } | { kind: 'scam' };

export function Dapps() {
  const app = useApp();
  const { cfg, wallet, svc } = app;
  const [policy, setPolicy] = useState<Awaited<ReturnType<typeof svc.policy>>>();
  const [amount, setAmount] = useState('200');
  const [flow, setFlow] = useState<Flow>();
  useEffect(() => {
    void svc.policy().then(setPolicy);
  }, [svc]);
  if (!wallet) return null;

  let depositAmount = 0n;
  try {
    depositAmount = parseUsdc(amount);
  } catch {
    depositAmount = 0n;
  }

  const build = (f: Flow) => {
    if (f.kind === 'deposit') {
      return prepareOp(
        app,
        wallet.account,
        accountCall.executeBatch([
          // exact approval, never unlimited
          { target: cfg.contracts.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.contracts.vault, f.amount] }) },
          {
            target: cfg.contracts.vault,
            value: 0n,
            data: encodeFunctionData({ abi: helvetiaYieldVaultAbi, functionName: 'deposit', args: [f.amount, wallet.account] }),
          },
        ]),
        NonceLane.COFFRE,
        'coffre',
      );
    }
    if (f.kind === 'withdraw') {
      return prepareOp(
        app,
        wallet.account,
        accountCall.execute(
          cfg.contracts.vault,
          0n,
          encodeFunctionData({ abi: helvetiaYieldVaultAbi, functionName: 'redeem', args: [wallet.vaultShares, wallet.account, wallet.account] }),
        ),
        NonceLane.COFFRE,
        'coffre',
      );
    }
    return prepareOp(
      app,
      wallet.account,
      accountCall.executeBatch([
        { target: cfg.contracts.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [cfg.contracts.scam, maxUint256] }) },
        { target: cfg.contracts.scam, value: 0n, data: encodeFunctionData({ abi: scamAirdropAbi, functionName: 'claimAirdrop' }) },
      ]),
      NonceLane.COFFRE,
      'coffre',
    );
  };

  return (
    <div className="screen dapps">
      <Header title="dApps" back={() => go('/')} />
      <p className="muted">
        Swissquote co-signs calls to approved protocols only, after simulating them. Approvals are always for an exact amount.
      </p>

      <section className="panel dapp">
        <div className="dapp-head">
          <div>
            <h2>Helvetia Yield Vault</h2>
            <span className="muted small">{policy?.approvedDapps[0]?.category ?? 'Tokenized money-market fund (demo)'}</span>
          </div>
          <span className="tag tag-ok">Approved</span>
        </div>
        <div className="dapp-position">
          <span className="muted small">Your position</span>
          <Money value={wallet.vaultAssets} size="m" />
        </div>
        <div className="row">
          <input className="input amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount to deposit" />
          <Button wide={false} disabled={depositAmount <= 0n || depositAmount > wallet.usdc} onClick={() => setFlow({ kind: 'deposit', amount: depositAmount })}>
            Deposit
          </Button>
        </div>
        {wallet.vaultShares > 0n && (
          <Button kind="secondary" onClick={() => setFlow({ kind: 'withdraw' })}>
            Withdraw everything ({formatUsdc(wallet.vaultAssets)} USDC)
          </Button>
        )}
      </section>

      <section className="panel scam-site">
        <div className="browser-bar">freeairdrop-claim.xyz</div>
        <h2>You’re eligible: 500 USDC airdrop</h2>
        <p className="small">Connect your wallet and claim before midnight. Thousands already claimed!</p>
        <Button kind="ink" onClick={() => setFlow({ kind: 'scam' })}>
          Claim 500 USDC
        </Button>
        <Notice kind="info">A website found through an ad. Watch what Swissquote’s simulation says before you sign.</Notice>
      </section>

      {flow && (
        <SignFlow
          title={flow.kind === 'deposit' ? `Deposit ${formatUsdc(flow.amount)} USDC` : flow.kind === 'withdraw' ? 'Withdraw from the vault' : 'Claim the airdrop'}
          mode="coffre"
          build={() => build(flow)}
          onClose={() => setFlow(undefined)}
        />
      )}
    </div>
  );
}
