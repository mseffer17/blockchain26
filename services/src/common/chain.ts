import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { chainFromDeployment, rutliAccountAbi, type Deployment } from '@rutli/sdk';

export function publicClient(d: Deployment): PublicClient {
  return createPublicClient({ chain: chainFromDeployment(d), transport: http(d.rpcUrl), pollingInterval: 500 });
}

export function walletClient(d: Deployment, account: Account) {
  return createWalletClient({ chain: chainFromDeployment(d), transport: http(d.rpcUrl), account });
}

export interface OnchainAccountState {
  deployed: boolean;
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
  pendingRecovery: { newPasskeyX: Hex; newPasskeyY: Hex; newCard: Address; executeAfter: number; epoch: number; reasonHash: Hex };
  pendingExit: { card: Address; executeAfter: number; epoch: number };
}

export async function readAccount(client: PublicClient, address: Address): Promise<OnchainAccountState | null> {
  const code = await client.getCode({ address });
  if (!code || code === '0x') return null;
  const s = await client.readContract({ address, abi: rutliAccountAbi, functionName: 'describe' });
  return {
    deployed: true,
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
      newPasskeyX: s.pendingRecovery.newPasskeyX,
      newPasskeyY: s.pendingRecovery.newPasskeyY,
      newCard: s.pendingRecovery.newCard,
      executeAfter: Number(s.pendingRecovery.executeAfter),
      epoch: Number(s.pendingRecovery.epoch),
      reasonHash: s.pendingRecovery.reasonHash,
    },
    pendingExit: {
      card: s.pendingExit.card,
      executeAfter: Number(s.pendingExit.executeAfter),
      epoch: Number(s.pendingExit.epoch),
    },
  };
}

/** Latest block timestamp (the chain's clock, which may differ from wall time on a local chain). */
export async function chainNow(client: PublicClient): Promise<number> {
  const b = await client.getBlock({ blockTag: 'latest' });
  return Number(b.timestamp);
}
