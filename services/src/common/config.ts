import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Deployment, NetworkName } from '@rutli/sdk';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const NETWORK = (process.env.RUTLI_NETWORK ?? 'local') as NetworkName;

export type ServiceName = 'sq-core' | 'sq-cosigner' | 'poste-guardian' | 'video-ident' | 'gas-station' | 'watchtower';

export const PORTS: Record<ServiceName, number> = {
  'sq-core': Number(process.env.SQ_CORE_PORT ?? 4000),
  'sq-cosigner': Number(process.env.SQ_COSIGNER_PORT ?? 4100),
  'poste-guardian': Number(process.env.POSTE_PORT ?? 4200),
  'video-ident': Number(process.env.VIDEO_IDENT_PORT ?? 4300),
  'gas-station': Number(process.env.GAS_STATION_PORT ?? 4400),
  watchtower: Number(process.env.WATCHTOWER_PORT ?? 4500),
};

export const SERVICE_URLS = {
  sqCore: process.env.SQ_CORE_URL ?? `http://localhost:${PORTS['sq-core']}`,
  cosigner: process.env.SQ_COSIGNER_URL ?? `http://localhost:${PORTS['sq-cosigner']}`,
  poste: process.env.POSTE_URL ?? `http://localhost:${PORTS['poste-guardian']}`,
  videoIdent: process.env.VIDEO_IDENT_URL ?? `http://localhost:${PORTS['video-ident']}`,
  gasStation: process.env.GAS_STATION_URL ?? `http://localhost:${PORTS['gas-station']}`,
  watchtower: process.env.WATCHTOWER_URL ?? `http://localhost:${PORTS.watchtower}`,
};

/**
 * Credentials between institutions (MOCK). In production: mutual TLS between Swissquote services,
 * and a contractual API with OAuth client credentials between Swissquote and La Poste.
 */
export const SWISSQUOTE_INTERNAL_KEY = process.env.SQ_INTERNAL_KEY ?? 'sq-internal-demo-key';
export const POSTE_PARTNER_KEY = process.env.POSTE_PARTNER_KEY ?? 'poste-partner-demo-key';

/** Demo switches. */
export const VIDEO_IDENT_AUTO_DECIDE = (process.env.VIDEO_IDENT_AUTO_DECIDE ?? 'true') === 'true';

export function deploymentPath(network: NetworkName = NETWORK): string {
  return join(REPO_ROOT, 'deployments', `${network}.json`);
}

let cached: Deployment | undefined;
export function loadDeployment(): Deployment {
  if (cached) return cached;
  const p = deploymentPath();
  if (!existsSync(p)) {
    throw new Error(
      `No deployment found at ${p}. Start a chain and run "npm run setup:${NETWORK}" first (or "npm run dev").`,
    );
  }
  cached = JSON.parse(readFileSync(p, 'utf8')) as Deployment;
  return cached;
}
