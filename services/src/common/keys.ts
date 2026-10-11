import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import type { Address, Hex } from 'viem';
import type { ServiceName } from './config';
import { dataDir } from './store';

/**
 * Each institution generates and keeps its OWN keys in its OWN data directory (keys.json).
 * In production these would live in an HSM (Swissquote) or in the partner's own HSM (La Poste);
 * here they are files, clearly mocked, but never shared between processes and never sent to the app.
 */
export interface ServiceKeys {
  'sq-core': { omnibusPrivateKey: Hex; credentialIssuerJwk: JWK };
  'sq-cosigner': { seedMnemonic: string };
  'poste-guardian': { seedMnemonic: string };
  'video-ident': { attestationJwk: JWK };
  'gas-station': { bundlerPrivateKey: Hex; sponsorPrivateKey: Hex };
  watchtower: Record<string, never>;
}

async function generate<S extends ServiceName>(service: S): Promise<ServiceKeys[S]> {
  switch (service) {
    case 'sq-core': {
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      return { omnibusPrivateKey: generatePrivateKey(), credentialIssuerJwk: await exportJWK(privateKey) } as never;
    }
    case 'sq-cosigner':
    case 'poste-guardian':
      return { seedMnemonic: generateMnemonic(wordlist, 256) } as never;
    case 'video-ident': {
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      return { attestationJwk: await exportJWK(privateKey) } as never;
    }
    case 'gas-station':
      return { bundlerPrivateKey: generatePrivateKey(), sponsorPrivateKey: generatePrivateKey() } as never;
    default:
      return {} as never;
  }
}

export async function ensureKeys<S extends ServiceName>(service: S): Promise<ServiceKeys[S]> {
  const file = join(dataDir(service), 'keys.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as ServiceKeys[S];
  const keys = await generate(service);
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/** Per-client key derived from the institution's seed: m/44'/60'/0'/0/<index>. One key per client keeps
 * clients unlinkable on-chain (banking secrecy): no shared "Swissquote co-signer" address appears in every wallet. */
export function deriveClientAccount(seedMnemonic: string, index: number) {
  return mnemonicToAccount(seedMnemonic, { addressIndex: index });
}

export function accountOf(privateKey: Hex) {
  return privateKeyToAccount(privateKey);
}

export type { Address };
