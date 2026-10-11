/** Factor bit flags — must match RutliAccount.sol. */
export const Factor = {
  PASSKEY: 1,
  CARD: 2,
  COSIGNER: 4,
  GUARDIAN: 8,
} as const;

export type FactorBit = (typeof Factor)[keyof typeof Factor];

export const FACTOR_LABEL: Record<FactorBit, string> = {
  1: 'Passkey (Face ID)',
  2: 'Recovery card',
  4: 'Swissquote co-signer',
  8: 'Independent guardian',
};

export const FACTOR_SHORT: Record<FactorBit, string> = { 1: 'P', 2: 'C', 4: 'S', 8: 'G' };

/**
 * ERC-4337 nonce "lanes" (the 192-bit nonce key). Operations in different lanes never invalidate each
 * other, so a pending co-signed transfer is not voided by a small payment, and security operations
 * prepared by Swissquote/La Poste are not voided by the client's daily activity.
 */
export const NonceLane = {
  PORTE_MONNAIE: 0n, // passkey-only spends
  COFFRE: 1n, // co-signed / card-signed calls and admin
  SECURITY: 2n, // freeze, rotations, recovery, exit, cancellations
} as const;

export const USDC_DECIMALS = 6;

/** EntryPoint v0.8 EIP-712 domain name/version (user operation hash). */
export const ENTRYPOINT_DOMAIN = { name: 'ERC4337', version: '1' } as const;

/** Canonical EntryPoint v0.8 address (deployed with the deterministic deployer on most chains). */
export const CANONICAL_ENTRYPOINT_V08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108' as const;

/** Prefix of the recovery-card QR payload. */
export const CARD_QR_PREFIX = 'rutli-card:v1:';

/** Domain-separated statement the passkey signs to prove wallet ownership to Swissquote (Travel Rule). */
export const OWNERSHIP_PROOF_TAG = 'RUTLI_WALLET_OWNERSHIP_PROOF_V1';
