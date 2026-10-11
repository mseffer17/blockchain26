import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import { OWNERSHIP_PROOF_TAG } from './constants';

/**
 * Travel Rule — proof that a Swissquote client controls a self-hosted wallet "by technical means"
 * (FINMA Guidance 02/2019). During onboarding, in an authenticated banking session, the client's passkey
 * signs this domain-separated challenge. Swissquote verifies the signature against the passkey that the
 * wallet address itself commits to (counterfactual CREATE2 address of the configuration, or on-chain
 * state once deployed). No screenshot, no "Satoshi test", no manual review.
 */
export function ownershipChallenge(p: { clientId: string; account: Address; chainId: number; nonce: Hex }): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [OWNERSHIP_PROOF_TAG, p.clientId, p.account, BigInt(p.chainId), p.nonce],
    ),
  );
}
