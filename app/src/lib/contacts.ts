import { getAddress, type Address } from 'viem';
import type { Deployment } from '@rutli/sdk';

/** Demo address book (the sanctioned and VASP entries match the mocked compliance provider). */
export function contacts(cfg: Deployment): Array<{ name: string; address: Address; note: string }> {
  return [
    { name: 'My Swissquote account', address: cfg.addresses.omnibus, note: 'Credited instantly: origin verified' },
    { name: 'Marc Dubois', address: getAddress('0x4f8b2c6e1d3a5b7c9e0f2a4c6e8b0d1f3a5c7e9b'), note: 'Husband' },
    { name: 'Dr. Weber dental lab', address: getAddress('0x6e1a3c5b7d9f0e2a4c6b8d0f1e3a5c7b9d2f4e6a'), note: 'Supplier' },
    { name: 'Bitstamp deposit (demo)', address: getAddress('0x7a5b000000000000000000000000000000000001'), note: 'Regulated exchange: Travel Rule data sent' },
    { name: 'Sanctioned entity (demo)', address: getAddress('0x5a0000000000000000000000000000000000dead'), note: 'On a sanctions list' },
  ];
}
