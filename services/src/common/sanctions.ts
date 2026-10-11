import type { Address } from 'viem';

/**
 * Sanctions screening list (MOCK of a compliance provider such as Chainalysis/Elliptic, fed by
 * OFAC SDN and the Swiss SECO lists).
 *
 * - The first entry is a real, public OFAC SDN digital-currency address (Lazarus Group, Ronin bridge
 *   exploit, designated April 2022).
 * - The others are fictitious addresses used in the demo.
 * SECO publishes entity names rather than wallet addresses; a production provider maps them.
 */
export const SANCTIONS: Array<{ address: string; entity: string; list: string }> = [
  { address: '0x098b716b8aaf21512996dc57eb0615e2383e2f96', entity: 'Lazarus Group (Ronin bridge exploit)', list: 'OFAC SDN' },
  { address: '0x5a0000000000000000000000000000000000dead', entity: 'DEMO — fictitious sanctioned exchange', list: 'SECO / OFAC (demo)' },
  { address: '0x5a000000000000000000000000000000000000c0', entity: 'DEMO — fictitious mixer', list: 'OFAC SDN (demo)' },
];

export function screen(address: Address | string): { hit: false } | { hit: true; entity: string; list: string } {
  const a = address.toLowerCase();
  const found = SANCTIONS.find((s) => s.address === a);
  return found ? { hit: true, entity: found.entity, list: found.list } : { hit: false };
}

/** Other regulated institutions (MOCK): payments to them carry Travel Rule data (IVMS101 over TRP). */
export const KNOWN_VASPS: Array<{ address: string; name: string; country: string }> = [
  { address: '0x7a5b000000000000000000000000000000000001', name: 'Bitstamp (demo deposit address)', country: 'LU' },
  { address: '0x7a5b000000000000000000000000000000000002', name: 'SEBA/AMINA Bank (demo deposit address)', country: 'CH' },
];

export function knownVasp(address: string) {
  return KNOWN_VASPS.find((v) => v.address === address.toLowerCase());
}
