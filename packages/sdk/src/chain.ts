import { defineChain, type Chain } from 'viem';
import { baseSepolia } from 'viem/chains';
import type { Deployment } from './types';

export function chainFromDeployment(d: Pick<Deployment, 'chainId' | 'rpcUrl' | 'network' | 'explorerUrl'>): Chain {
  if (d.chainId === baseSepolia.id) {
    return { ...baseSepolia, rpcUrls: { default: { http: [d.rpcUrl] } } };
  }
  return defineChain({
    id: d.chainId,
    name: d.network === 'local' ? 'Anvil (local)' : d.network,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [d.rpcUrl] } },
    blockExplorers: d.explorerUrl ? { default: { name: 'Explorer', url: d.explorerUrl } } : undefined,
  });
}

export function explorerTxUrl(d: Pick<Deployment, 'explorerUrl'>, hash: string): string | undefined {
  return d.explorerUrl ? `${d.explorerUrl}/tx/${hash}` : undefined;
}

export function explorerAddressUrl(d: Pick<Deployment, 'explorerUrl'>, address: string): string | undefined {
  return d.explorerUrl ? `${d.explorerUrl}/address/${address}` : undefined;
}
