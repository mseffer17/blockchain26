import { bytesToHex, concatHex, hexToBytes, numberToHex, sha256, stringToHex, type Hex } from 'viem';
import { p256 } from '@noble/curves/nist.js';
import { base64UrlEncode, encodeWebAuthnFactor } from './signature';
import type { PasskeyPublicKey } from './types';

/**
 * A software WebAuthn authenticator producing byte-for-byte the same assertions as a platform passkey
 * (authenticatorData + clientDataJSON + P-256 signature with UP and UV flags).
 *
 * Used by: the automated end-to-end test, the attacker simulation scripts, and the app's
 * "demo device" fallback when the laptop used for the pitch has no usable platform authenticator.
 * Production always uses the device's real passkey (Secure Enclave / StrongBox), see webauthn.ts.
 */
export class SoftPasskey {
  private signCount = 1;

  constructor(
    readonly privateKey: Hex,
    readonly rpId: string = 'localhost',
    readonly origin: string = 'http://localhost:5173',
  ) {}

  static generate(rpId?: string, origin?: string): SoftPasskey {
    return new SoftPasskey(bytesToHex(p256.utils.randomSecretKey()), rpId, origin);
  }

  get publicKey(): PasskeyPublicKey {
    const pub = p256.getPublicKey(hexToBytes(this.privateKey), false); // 0x04 || x || y
    return { x: bytesToHex(pub.slice(1, 33)), y: bytesToHex(pub.slice(33, 65)) };
  }

  /** Returns the PASSKEY factor data (abi-encoded WebAuthn assertion) for a 32-byte challenge. */
  sign(challenge: Hex): Hex {
    const flags = 0x05; // UP | UV ("Face ID passed")
    const authenticatorData = concatHex([
      sha256(stringToHex(this.rpId)),
      numberToHex(flags, { size: 1 }),
      numberToHex(this.signCount++, { size: 4 }),
    ]);
    const clientDataJSON = JSON.stringify({
      type: 'webauthn.get',
      challenge: base64UrlEncode(hexToBytes(challenge)),
      origin: this.origin,
      crossOrigin: false,
    });
    const digest = hexToBytes(sha256(concatHex([authenticatorData, sha256(stringToHex(clientDataJSON))])));
    const sig = p256.sign(digest, hexToBytes(this.privateKey), { prehash: false, lowS: true });
    const r = BigInt(bytesToHex(sig.slice(0, 32)));
    const s = BigInt(bytesToHex(sig.slice(32, 64)));
    return encodeWebAuthnFactor({
      r,
      s,
      challengeIndex: clientDataJSON.indexOf('"challenge"'),
      typeIndex: clientDataJSON.indexOf('"type"'),
      authenticatorData,
      clientDataJSON,
    });
  }
}
