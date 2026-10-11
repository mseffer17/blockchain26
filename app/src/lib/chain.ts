import { createPublicClient, erc20Abi, http, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import {
  Factor,
  RADIOGRAPHY_ACTIONS,
  RADIOGRAPHY_ACTORS,
  SELECTORS,
  chainFromDeployment,
  entryPointAbi,
  helvetiaYieldVaultAbi,
  rutliAccountAbi,
  type Deployment,
} from '@rutli/sdk';

export function makeClient(cfg: Deployment): PublicClient {
  return createPublicClient({ chain: chainFromDeployment(cfg), transport: http(cfg.rpcUrl), pollingInterval: 1000 });
}

export interface WalletState {
  account: Address;
  deployed: boolean;
  usdc: bigint;
  eth: bigint;
  vaultShares: bigint;
  vaultAssets: bigint;
  passkeyX: Hex;
  passkeyY: Hex;
  card: Address;
  cosigner: Address;
  guardian: Address;
  recoveryDelay: number;
  exitDelay: number;
  frozenUntil: number;
  securityEpoch: number;
  sovereign: boolean;
  pendingRecovery: { newCard: Address; executeAfter: number; newPasskeyX: Hex };
  pendingExit: { card: Address; executeAfter: number };
  allowance: { limit: bigint; spent: bigint; remaining: bigint; windowEnd: number };
  chainTime: number;
  blockNumber: bigint;
  fetchedAt: number;
}

export async function readWallet(pc: PublicClient, cfg: Deployment, account: Address): Promise<WalletState> {
  const [code, usdc, eth, block] = await Promise.all([
    pc.getCode({ address: account }),
    pc.readContract({ address: cfg.contracts.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    pc.getBalance({ address: account }),
    pc.getBlock({ blockTag: 'latest' }),
  ]);
  const deployed = !!code && code !== '0x';
  const vaultShares = await pc.readContract({ address: cfg.contracts.vault, abi: helvetiaYieldVaultAbi, functionName: 'balanceOf', args: [account] });
  const vaultAssets =
    vaultShares > 0n
      ? await pc.readContract({ address: cfg.contracts.vault, abi: helvetiaYieldVaultAbi, functionName: 'convertToAssets', args: [vaultShares] })
      : 0n;
  const base = {
    account,
    deployed,
    usdc,
    eth,
    vaultShares,
    vaultAssets,
    chainTime: Number(block.timestamp),
    blockNumber: block.number,
    fetchedAt: Date.now(),
  };
  if (!deployed) {
    return {
      ...base,
      passkeyX: '0x',
      passkeyY: '0x',
      card: '0x0000000000000000000000000000000000000000',
      cosigner: '0x0000000000000000000000000000000000000000',
      guardian: '0x0000000000000000000000000000000000000000',
      recoveryDelay: 0,
      exitDelay: 0,
      frozenUntil: 0,
      securityEpoch: 0,
      sovereign: false,
      pendingRecovery: { newCard: '0x0000000000000000000000000000000000000000', executeAfter: 0, newPasskeyX: '0x' },
      pendingExit: { card: '0x0000000000000000000000000000000000000000', executeAfter: 0 },
      allowance: { limit: 0n, spent: 0n, remaining: 0n, windowEnd: 0 },
    };
  }
  const [s, al] = await Promise.all([
    pc.readContract({ address: account, abi: rutliAccountAbi, functionName: 'describe' }),
    pc.readContract({ address: account, abi: rutliAccountAbi, functionName: 'allowance', args: [cfg.contracts.usdc] }),
  ]);
  return {
    ...base,
    passkeyX: s.passkeyX,
    passkeyY: s.passkeyY,
    card: s.card,
    cosigner: s.cosigner,
    guardian: s.guardian,
    recoveryDelay: Number(s.recoveryDelay),
    exitDelay: Number(s.exitDelay),
    frozenUntil: Number(s.frozenUntil),
    securityEpoch: Number(s.securityEpoch),
    sovereign: s.sovereign,
    pendingRecovery: {
      newCard: s.pendingRecovery.newCard,
      executeAfter: Number(s.pendingRecovery.executeAfter),
      newPasskeyX: s.pendingRecovery.newPasskeyX,
    },
    pendingExit: { card: s.pendingExit.card, executeAfter: Number(s.pendingExit.executeAfter) },
    allowance: { limit: al[0], spent: al[1], remaining: al[2], windowEnd: Number(al[3]) },
  };
}

/** Chain "now", extrapolated from the last read (the local chain can be time-travelled). */
export function chainNow(w: Pick<WalletState, 'chainTime' | 'fetchedAt'>): number {
  return w.chainTime + Math.floor((Date.now() - w.fetchedAt) / 1000);
}

export async function getNonce(pc: PublicClient, cfg: Deployment, account: Address, lane: bigint) {
  return pc.readContract({ address: cfg.contracts.entryPoint, abi: entryPointAbi, functionName: 'getNonce', args: [account, lane] });
}

/** Ask the live contract who may do what (RutliAccount.canAuthorize). */
export async function readPact(pc: PublicClient, account: Address) {
  const answers: Record<string, Record<string, boolean>> = {};
  await Promise.all(
    RADIOGRAPHY_ACTORS.flatMap((actor) =>
      RADIOGRAPHY_ACTIONS.map(async (action) => {
        const ok = await pc.readContract({
          address: account,
          abi: rutliAccountAbi,
          functionName: 'canAuthorize',
          args: [action.selector, actor.mask],
        });
        (answers[actor.id] ??= {})[action.id] = ok;
      }),
    ),
  );
  const block = await pc.getBlockNumber();
  return { answers, block };
}

export async function canAuthorize(pc: PublicClient, account: Address, selector: Hex, mask: number) {
  return pc.readContract({ address: account, abi: rutliAccountAbi, functionName: 'canAuthorize', args: [selector, mask] });
}

export { SELECTORS, Factor };

export interface ActivityItem {
  kind: 'in' | 'out';
  amount: bigint;
  counterparty: Address;
  txHash: Hex;
  blockNumber: bigint;
}

const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

/** USDC movements of the wallet, newest first (public chain data). */
export async function readActivity(pc: PublicClient, cfg: Deployment, account: Address): Promise<ActivityItem[]> {
  const latest = await pc.getBlockNumber();
  const fromBlock = cfg.network === 'local' ? 0n : latest > 40_000n ? latest - 40_000n : 0n;
  const [outs, ins] = await Promise.all([
    pc.getLogs({ address: cfg.contracts.usdc, event: transferEvent, args: { from: account }, fromBlock }),
    pc.getLogs({ address: cfg.contracts.usdc, event: transferEvent, args: { to: account }, fromBlock }),
  ]);
  const items: ActivityItem[] = [
    ...outs.map((l) => ({ kind: 'out' as const, amount: l.args.value!, counterparty: l.args.to!, txHash: l.transactionHash, blockNumber: l.blockNumber })),
    ...ins.map((l) => ({ kind: 'in' as const, amount: l.args.value!, counterparty: l.args.from!, txHash: l.transactionHash, blockNumber: l.blockNumber })),
  ];
  return items.sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 25);
}
