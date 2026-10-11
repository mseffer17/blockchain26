import {
  bytesToHex,
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  hexToBytes,
  numberToHex,
  recoverAddress,
  sha256,
  size,
  sliceHex,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { p256 } from '@noble/curves/nist.js';
import { Factor, type FactorBit } from './constants';
import type { WebAuthnAssertion } from './types';

/** P-256 group order. */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

export interface FactorSignature {
  factor: FactorBit;
  data: Hex;
}

const SINGLE_FACTORS: FactorBit[] = [Factor.PASSKEY, Factor.CARD, Factor.COSIGNER, Factor.GUARDIAN];

/**
 * Encode the signature blob verified by RutliAccount._verifyFactors:
 *   uint8 count | count × (uint8 factor | uint16 size | bytes data)
 * Entries are emitted in canonical order (P, C, S, G); each factor at most once.
 */
export function encodeFactorSignatures(sigs: FactorSignature[]): Hex {
  const byFactor = new Map<FactorBit, Hex>();
  for (const s of sigs) {
    if (!SINGLE_FACTORS.includes(s.factor)) throw new Error(`invalid factor ${s.factor}`);
    if (byFactor.has(s.factor)) throw new Error(`duplicate factor ${s.factor}`);
    byFactor.set(s.factor, s.data);
  }
  if (byFactor.size === 0 || byFactor.size > 4) throw new Error('1 to 4 factor signatures required');
  const parts: Hex[] = [numberToHex(byFactor.size, { size: 1 })];
  for (const f of SINGLE_FACTORS) {
    const data = byFactor.get(f);
    if (!data) continue;
    const len = size(data);
    if (len > 0xffff) throw new Error('factor signature too large');
    parts.push(numberToHex(f, { size: 1 }), numberToHex(len, { size: 2 }), data);
  }
  return concatHex(parts);
}

/** Inverse of {encodeFactorSignatures}. Throws on malformed input. */
export function decodeFactorSignatures(sig: Hex): FactorSignature[] {
  const bytes = hexToBytes(sig);
  if (bytes.length < 4) throw new Error('signature too short');
  const count = bytes[0]!;
  if (count < 1 || count > 4) throw new Error('bad factor count');
  const out: FactorSignature[] = [];
  let cursor = 1;
  for (let i = 0; i < count; i++) {
    if (bytes.length - cursor < 3) throw new Error('truncated header');
    const factor = bytes[cursor]! as FactorBit;
    const len = (bytes[cursor + 1]! << 8) | bytes[cursor + 2]!;
    cursor += 3;
    if (bytes.length - cursor < len) throw new Error('truncated data');
    if (!SINGLE_FACTORS.includes(factor)) throw new Error(`invalid factor ${factor}`);
    if (out.some((o) => o.factor === factor)) throw new Error('duplicate factor');
    out.push({ factor, data: bytesToHex(bytes.slice(cursor, cursor + len)) });
    cursor += len;
  }
  if (cursor !== bytes.length) throw new Error('trailing bytes');
  return out;
}

/** Add (or replace) one factor signature in an existing blob ('0x' = empty). */
export function addFactorSignature(existing: Hex, sig: FactorSignature): Hex {
  const current = existing === '0x' || existing === ('' as Hex) ? [] : decodeFactorSignatures(existing);
  return encodeFactorSignatures([...current.filter((c) => c.factor !== sig.factor), sig]);
}

export function factorMask(sig: Hex): number {
  if (sig === '0x') return 0;
  return decodeFactorSignatures(sig).reduce((m, s) => m | s.factor, 0);
}

// ── WebAuthn ──────────────────────────────────────────────────────────────────

/** Normalize a P-256 `s` to the lower half of the curve order (OpenZeppelin rejects high-s). */
export function normalizeS(s: bigint): bigint {
  return s > P256_N / 2n ? P256_N - s : s;
}

/** Encoding expected by OpenZeppelin `WebAuthn.tryDecodeAuth`: abi.encode of the 6 fields (no outer offset). */
export function encodeWebAuthnFactor(a: WebAuthnAssertion): Hex {
  return encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes' },
      { type: 'string' },
    ],
    [
      numberToHex(a.r, { size: 32 }),
      numberToHex(normalizeS(a.s), { size: 32 }),
      BigInt(a.challengeIndex),
      BigInt(a.typeIndex),
      a.authenticatorData,
      a.clientDataJSON,
    ],
  );
}

export function decodeWebAuthnFactor(data: Hex): WebAuthnAssertion {
  const [r, s, challengeIndex, typeIndex, authenticatorData, clientDataJSON] = decodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'bytes32' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'bytes' },
      { type: 'string' },
    ],
    data,
  );
  return {
    r: BigInt(r),
    s: BigInt(s),
    challengeIndex: Number(challengeIndex),
    typeIndex: Number(typeIndex),
    authenticatorData,
    clientDataJSON,
  };
}

/** base64url without padding (WebAuthn challenge encoding). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Parse an ASN.1 DER ECDSA signature (what authenticators return) into (r, s). */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  if (der[i++] !== 0x30) throw new Error('DER: expected sequence');
  // sequence length (short or long form)
  let seqLen = der[i++]!;
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | der[i++]!;
  }
  const readInt = (): bigint => {
    if (der[i++] !== 0x02) throw new Error('DER: expected integer');
    const len = der[i++]!;
    const bytes = der.slice(i, i + len);
    i += len;
    return BigInt(bytesToHex(bytes));
  };
  const r = readInt();
  const s = readInt();
  return { r, s };
}

/**
 * Off-chain mirror of OpenZeppelin WebAuthn.verify (used by Swissquote's co-signer before it co-signs, and by
 * Swissquote core banking to check wallet-ownership proofs). Same checks: type, challenge, UP+UV flags,
 * BE/BS consistency, low-s, P-256 signature over sha256(authenticatorData || sha256(clientDataJSON)).
 */
export function verifyWebAuthnFactor(challenge: Hex, data: Hex, x: Hex, y: Hex): boolean {
  try {
    const a = decodeWebAuthnFactor(data);
    const cdj = a.clientDataJSON;
    if (cdj.slice(a.typeIndex, a.typeIndex + 21) !== '"type":"webauthn.get"') return false;
    const expected = `"challenge":"${base64UrlEncode(hexToBytes(challenge))}"`;
    if (cdj.slice(a.challengeIndex, a.challengeIndex + expected.length) !== expected) return false;
    const auth = hexToBytes(a.authenticatorData);
    if (auth.length < 37) return false;
    const flags = auth[32]!;
    if ((flags & 0x01) === 0 || (flags & 0x04) === 0) return false; // UP and UV
    if ((flags & 0x08) === 0 && (flags & 0x10) !== 0) return false; // BS without BE
    if (a.s > P256_N / 2n || a.r === 0n || a.s === 0n) return false;
    const message = concatHex([a.authenticatorData, sha256(stringToHex(cdj))]);
    const digest = hexToBytes(sha256(message));
    const pub = hexToBytes(concatHex(['0x04', x, y]));
    const sig = hexToBytes(concatHex([numberToHex(a.r, { size: 32 }), numberToHex(a.s, { size: 32 })]));
    return p256.verify(sig, digest, pub, { prehash: false, lowS: true });
  } catch {
    return false;
  }
}

/** Off-chain mirror of the ECDSA factor check (card, co-signer, guardian). */
export async function verifyEcdsaFactor(hash: Hex, data: Hex, expected: Address): Promise<boolean> {
  try {
    if (size(data) !== 65) return false;
    const recovered = await recoverAddress({ hash, signature: data });
    return recovered.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

/** Split a 65-byte ECDSA signature (r||s||v). */
export function splitEcdsa(sig: Hex) {
  return { r: sliceHex(sig, 0, 32), s: sliceHex(sig, 32, 64), v: sliceHex(sig, 64, 65) };
}
