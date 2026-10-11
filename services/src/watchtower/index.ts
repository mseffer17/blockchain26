/**
 * WATCHTOWER — open-source monitor that anyone can run                      [REAL, not a mock]
 *
 * The client, a family member, Swissquote, an auditor or the regulator can run it: it only reads public
 * chain data. It watches every Rütli account created by the factory and raises an alarm on every
 * security event (recovery or exit started, keys replaced, freeze...). The delays of the pact are only
 * protective if someone is looking: this is that someone.
 *
 * In the demo it forwards alerts to Swissquote's notification service, and finalizes matured recoveries
 * (anyone may call finalizeRecovery; Swissquote's gas station pays).
 */
import type { Address, Hex } from 'viem';
import { parseEventLogs } from 'viem';
import { api, formatDuration, rutliAccountAbi, rutliFactoryAbi, shortAddress } from '@rutli/sdk';
import { SERVICE_URLS, SWISSQUOTE_INTERNAL_KEY, loadDeployment } from '../common/config';
import { chainNow, publicClient } from '../common/chain';
import { createApp, start } from '../common/http';
import { JsonStore } from '../common/store';

const SERVICE = 'watchtower' as const;
const d = loadDeployment();
const pc = publicClient(d);
const AUTO_FINALIZE = (process.env.WATCHTOWER_AUTO_FINALIZE ?? 'true') === 'true';

interface Alert {
  at: number;
  block: string;
  account: Address;
  event: string;
  level: 'info' | 'warning' | 'danger' | 'success';
  title: string;
  body: string;
  txHash: Hex;
}

const db = new JsonStore(SERVICE, 'db', () => ({
  lastBlock: '0',
  accounts: [] as Address[],
  pendingRecoveries: {} as Record<string, number>,
  alerts: [] as Alert[],
}));

function describe(name: string, args: Record<string, unknown>): Pick<Alert, 'level' | 'title' | 'body'> | null {
  switch (name) {
    case 'RecoveryInitiated': {
      const wait = Number(args.executeAfter) - Math.floor(Date.now() / 1000);
      return {
        level: 'danger',
        title: 'Recovery started on your wallet',
        body: `Swissquote + La Poste started replacing your passkey and card (executes in ~${formatDuration(Math.max(wait, 0))}). Not you? Cancel with Face ID or your card.`,
      };
    }
    case 'RecoveryCancelled':
      return { level: 'success', title: 'Recovery cancelled', body: 'The pending recovery was cancelled.' };
    case 'RecoveryFinalized':
      return { level: 'warning', title: 'Recovery completed', body: 'A new passkey and a new card now control the wallet.' };
    case 'ExitInitiated':
      return {
        level: 'danger',
        title: 'Exit started with the recovery card',
        body: 'After the delay the card alone will control the wallet and Swissquote will be removed. Not you? Cancel with Face ID.',
      };
    case 'ExitCancelled':
      return { level: 'success', title: 'Exit cancelled', body: 'The pending exit was cancelled.' };
    case 'ExitFinalized':
      return { level: 'warning', title: 'Sovereign mode', body: 'The card now has full control; Swissquote and La Poste were removed.' };
    case 'PasskeyRotated':
      return { level: 'warning', title: 'Passkey replaced', body: 'A new device now holds your passkey.' };
    case 'CardRotated':
      return { level: 'warning', title: 'Recovery card replaced', body: `New card ${shortAddress(String(args.card))}.` };
    case 'CosignerChanged':
      return { level: 'warning', title: 'Swissquote co-signer key changed', body: `New key ${shortAddress(String(args.cosigner))}.` };
    case 'GuardianChanged':
      return { level: 'warning', title: 'Guardian changed', body: `New guardian ${shortAddress(String(args.guardian))}.` };
    case 'Frozen':
      return { level: 'danger', title: 'Face-ID spending frozen', body: 'Only two-factor operations work until the freeze ends.' };
    case 'Unfrozen':
      return { level: 'info', title: 'Freeze lifted', body: 'Face-ID spending works again.' };
    default:
      return null;
  }
}

async function tick() {
  const latest = await pc.getBlockNumber();
  const from = BigInt(db.data.lastBlock) + 1n;
  if (from > latest) return finalizeMatured();
  const toBlock = latest - from > 5000n ? from + 5000n : latest;

  const created = await pc.getContractEvents({
    address: d.contracts.factory,
    abi: rutliFactoryAbi,
    eventName: 'AccountCreated',
    fromBlock: from,
    toBlock,
  });
  db.update((s) => {
    for (const e of created) if (!s.accounts.includes(e.args.account!)) s.accounts.push(e.args.account!);
  });

  if (db.data.accounts.length > 0) {
    const logs = await pc.getLogs({ address: db.data.accounts, fromBlock: from, toBlock });
    const events = parseEventLogs({ abi: rutliAccountAbi, logs });
    for (const e of events) {
      const args = (e.args ?? {}) as Record<string, unknown>;
      if (e.eventName === 'RecoveryInitiated') {
        db.update((s) => (s.pendingRecoveries[e.address.toLowerCase()] = Number(args.executeAfter)));
      }
      if (e.eventName === 'RecoveryCancelled' || e.eventName === 'RecoveryFinalized') {
        db.update((s) => delete s.pendingRecoveries[e.address.toLowerCase()]);
      }
      const desc = describe(e.eventName, args);
      if (!desc) continue;
      const alert: Alert = { at: Date.now(), block: e.blockNumber.toString(), account: e.address, event: e.eventName, txHash: e.transactionHash, ...desc };
      db.update((s) => {
        s.alerts.unshift(alert);
        s.alerts = s.alerts.slice(0, 300);
      });
      console.log(`\x1b[90m[watchtower]\x1b[0m ${alert.level.toUpperCase()} ${e.eventName} on ${shortAddress(e.address)} — ${alert.title}`);
      await api(`${SERVICE_URLS.sqCore}/internal/notify`, {
        headers: { 'x-sq-internal-key': SWISSQUOTE_INTERNAL_KEY },
        body: { account: e.address, ...desc, channels: ['app', 'email', 'sms', 'watchtower'] },
      }).catch(() => undefined);
    }
  }
  db.update((s) => (s.lastBlock = toBlock.toString()));
  await finalizeMatured();
}

async function finalizeMatured() {
  if (!AUTO_FINALIZE) return;
  const now = await chainNow(pc);
  for (const [account, executeAfter] of Object.entries(db.data.pendingRecoveries)) {
    if (now < executeAfter) continue;
    try {
      await api(`${SERVICE_URLS.gasStation}/relay/finalize`, { body: { account, kind: 'recovery' } });
      console.log(`\x1b[90m[watchtower]\x1b[0m finalized matured recovery on ${shortAddress(account)}`);
      db.update((s) => delete s.pendingRecoveries[account]);
    } catch {
      /* not ready yet / already done */
    }
  }
}

let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await tick();
  } catch {
    /* chain not reachable yet */
  } finally {
    busy = false;
  }
}, 2000);

const app = createApp(SERVICE);
app.get('/alerts', (_req, res) => {
  res.json({ accounts: db.data.accounts, alerts: db.data.alerts.slice(0, 100) });
});
start(app, SERVICE, `Watchtower (auto-finalize matured recoveries: ${AUTO_FINALIZE})`);
