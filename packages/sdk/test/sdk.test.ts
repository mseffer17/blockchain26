import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex, type Hex } from 'viem';
import {
  Factor,
  SoftPasskey,
  addFactorSignature,
  cardAccount,
  cardQrPayload,
  cardSign,
  decodeAccountCall,
  decodeFactorSignatures,
  decodeWebAuthnFactor,
  describeIntent,
  encodeFactorSignatures,
  factorMask,
  formatUsdc,
  generateCardMnemonic,
  isValidCard,
  normalizeCardWords,
  parseDerSignature,
  parseUsdc,
  accountCall,
  verifyEcdsaFactor,
  verifyWebAuthnFactor,
  P256_N,
} from '../src/index';

const hash = keccak256(toHex('rutli'));

test('factor signature blob roundtrip, canonical order', () => {
  const blob = encodeFactorSignatures([
    { factor: Factor.COSIGNER, data: '0x1111' },
    { factor: Factor.PASSKEY, data: '0x2222' },
  ]);
  // count=2 | P(1) len 2 0x2222 | S(4) len 2 0x1111
  assert.equal(blob, '0x02010002222204000211 11'.replace(/ /g, '') as Hex);
  const decoded = decodeFactorSignatures(blob);
  assert.deepEqual(decoded.map((d) => d.factor), [Factor.PASSKEY, Factor.COSIGNER]);
  assert.equal(factorMask(blob), Factor.PASSKEY | Factor.COSIGNER);
  const withCard = addFactorSignature(blob, { factor: Factor.CARD, data: '0x33' });
  assert.equal(factorMask(withCard), 7);
  assert.throws(() => encodeFactorSignatures([{ factor: 1, data: '0x' }, { factor: 1, data: '0x' }]));
  assert.throws(() => decodeFactorSignatures(`${blob}00` as Hex));
});

test('soft passkey produces assertions that pass the off-chain WebAuthn verifier', () => {
  const pk = SoftPasskey.generate();
  const data = pk.sign(hash);
  const { x, y } = pk.publicKey;
  assert.equal(verifyWebAuthnFactor(hash, data, x, y), true);
  assert.equal(verifyWebAuthnFactor(keccak256(toHex('other')), data, x, y), false, 'wrong challenge');
  const other = SoftPasskey.generate().publicKey;
  assert.equal(verifyWebAuthnFactor(hash, data, other.x, other.y), false, 'wrong key');
  const a = decodeWebAuthnFactor(data);
  assert.ok(a.s <= P256_N / 2n, 'low-s');
  assert.equal(a.clientDataJSON.slice(a.typeIndex, a.typeIndex + 21), '"type":"webauthn.get"');
});

test('recovery card: generation, normalization, QR, signature', async () => {
  const words = generateCardMnemonic();
  assert.equal(words.split(' ').length, 12);
  assert.ok(isValidCard(words));
  const qr = cardQrPayload(words);
  assert.ok(qr.startsWith('rutli-card:v1:'));
  assert.equal(normalizeCardWords(qr), words);
  assert.equal(normalizeCardWords(words.toUpperCase().split(' ').join('\n')), words);
  assert.equal(isValidCard('abandon abandon abandon'), false);
  const sig = await cardSign(words, hash);
  assert.equal(await verifyEcdsaFactor(hash, sig, cardAccount(words).address), true);
});

test('DER signature parsing', () => {
  // 30 44 02 20 <32 bytes r> 02 20 <32 bytes s>
  const r = new Uint8Array(32).fill(1);
  const s = new Uint8Array(32).fill(2);
  const der = new Uint8Array([0x30, 0x44, 0x02, 0x20, ...r, 0x02, 0x20, ...s]);
  const out = parseDerSignature(der);
  assert.equal(out.r, BigInt('0x' + '01'.repeat(32)));
  assert.equal(out.s, BigInt('0x' + '02'.repeat(32)));
});

test('intent decoding and plain-language description', () => {
  const usdc = '0x0000000000000000000000000000000000000aaa' as const;
  const bob = '0x0000000000000000000000000000000000000b0b' as const;
  const spend = decodeAccountCall(accountCall.spend(usdc, bob, 1_500_000n));
  assert.equal(spend.kind, 'spend');
  assert.deepEqual(describeIntent(spend, { usdc, names: { [bob.toLowerCase()]: 'Bob' } }), [
    'Send 1.50 USDC to Bob (0x0000…0B0b)',
  ]);
  assert.equal(formatUsdc(parseUsdc("12'345.6")), "12'345.60");
});
