/// <reference lib="dom" />
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { base64UrlDecode, encodeWebAuthnFactor, normalizeS, parseDerSignature } from './signature';
import type { PasskeyPublicKey } from './types';

/**
 * Real passkeys through the browser WebAuthn API (Face ID / Touch ID / Windows Hello / Android).
 * The private key never leaves the authenticator (Secure Enclave, StrongBox, TPM). Only the P-256
 * public key is stored on-chain in the account.
 */

export function isWebAuthnAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function copy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

export async function createPasskey(opts: {
  rpId: string;
  rpName: string;
  userName: string;
  userDisplayName: string;
}): Promise<{ credentialId: string; publicKey: PasskeyPublicKey }> {
  const challenge = copy(crypto.getRandomValues(new Uint8Array(32)));
  const userId = copy(crypto.getRandomValues(new Uint8Array(16)));
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: opts.rpId, name: opts.rpName },
      user: { id: userId, name: opts.userName, displayName: opts.userDisplayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 = P-256, the only curve verifiable on-chain
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      attestation: 'none',
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey creation was cancelled');
  const response = credential.response as AuthenticatorAttestationResponse;
  return { credentialId: credential.id, publicKey: extractPublicKey(response) };
}

/** Sign a 32-byte challenge (the userOpHash) and return the PASSKEY factor data for the account. */
export async function signWithPasskey(opts: { credentialId: string; rpId: string; challenge: Hex }): Promise<Hex> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: copy(hexToBytes(opts.challenge)),
      rpId: opts.rpId,
      allowCredentials: [{ type: 'public-key', id: copy(base64UrlDecode(opts.credentialId)) }],
      userVerification: 'required',
      timeout: 120_000,
    },
  })) as PublicKeyCredential | null;
  if (!assertion) throw new Error('Face ID was cancelled');
  const response = assertion.response as AuthenticatorAssertionResponse;
  const clientDataJSON = new TextDecoder().decode(new Uint8Array(response.clientDataJSON));
  const authenticatorData = bytesToHex(new Uint8Array(response.authenticatorData));
  const { r, s } = parseDerSignature(new Uint8Array(response.signature));
  return encodeWebAuthnFactor({
    r,
    s: normalizeS(s), // authenticators return random s; the contract (OpenZeppelin P256) requires low-s
    challengeIndex: clientDataJSON.indexOf('"challenge"'),
    typeIndex: clientDataJSON.indexOf('"type"'),
    authenticatorData,
    clientDataJSON,
  });
}

/** Extract (x, y) of the new P-256 credential. */
function extractPublicKey(response: AuthenticatorAttestationResponse): PasskeyPublicKey {
  // Modern browsers: SubjectPublicKeyInfo DER; the uncompressed point (0x04 || x || y) is the last 65 bytes.
  if (typeof response.getPublicKey === 'function') {
    const alg = typeof response.getPublicKeyAlgorithm === 'function' ? response.getPublicKeyAlgorithm() : -7;
    if (alg !== -7) throw new Error('The authenticator did not create a P-256 (ES256) key');
    const spki = response.getPublicKey();
    if (spki) {
      const der = new Uint8Array(spki);
      const point = der.slice(der.length - 65);
      if (point[0] === 0x04) return { x: bytesToHex(point.slice(1, 33)), y: bytesToHex(point.slice(33, 65)) };
    }
  }
  // Fallback: parse the COSE key inside attestationObject.authData.
  const att = cborDecode(new Uint8Array(response.attestationObject)) as Map<unknown, unknown>;
  const authData = att.get('authData') as Uint8Array;
  const flags = authData[32]!;
  if ((flags & 0x40) === 0) throw new Error('No attested credential data');
  const credIdLen = (authData[53]! << 8) | authData[54]!;
  const coseStart = 55 + credIdLen;
  const cose = cborDecode(authData.slice(coseStart)) as Map<number, unknown>;
  if (cose.get(3) !== -7) throw new Error('The authenticator did not create a P-256 (ES256) key');
  return { x: bytesToHex(cose.get(-2) as Uint8Array), y: bytesToHex(cose.get(-3) as Uint8Array) };
}

/** Minimal CBOR decoder (maps, arrays, byte/text strings, integers) sufficient for WebAuthn attestation. */
function cborDecode(data: Uint8Array): unknown {
  let i = 0;
  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return data[i++]!;
    if (info === 25) return (data[i++]! << 8) | data[i++]!;
    if (info === 26) return ((data[i++]! << 24) >>> 0) + (data[i++]! << 16) + (data[i++]! << 8) + data[i++]!;
    throw new Error('CBOR: unsupported length');
  };
  const item = (): unknown => {
    const byte = data[i++]!;
    const major = byte >> 5;
    const info = byte & 0x1f;
    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        const n = readLength(info);
        const v = data.slice(i, i + n);
        i += n;
        return v;
      }
      case 3: {
        const n = readLength(info);
        const v = new TextDecoder().decode(data.slice(i, i + n));
        i += n;
        return v;
      }
      case 4: {
        const n = readLength(info);
        return Array.from({ length: n }, () => item());
      }
      case 5: {
        const n = readLength(info);
        const m = new Map<unknown, unknown>();
        for (let k = 0; k < n; k++) m.set(item(), item());
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('CBOR: unsupported simple value');
      default:
        throw new Error(`CBOR: unsupported major type ${major}`);
    }
  };
  return item();
}

