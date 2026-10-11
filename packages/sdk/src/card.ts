import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { mnemonicToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { CARD_QR_PREFIX } from './constants';

/**
 * The paper recovery card (factor C).
 *
 * 12 BIP-39 words (128 bits of entropy) printed with a QR code. Generated on the client's device, never
 * sent anywhere. It is ONE factor among four: alone it can only freeze, cancel, or start a 30-day exit.
 * It derives a standard secp256k1 key (m/44'/60'/0'/0/0), so any open-source wallet software can use it
 * forever — even if Swissquote, its website and its domain name disappear.
 */

export function generateCardMnemonic(): string {
  return generateMnemonic(wordlist, 128);
}

export function normalizeCardWords(input: string): string {
  const trimmed = input.trim();
  const body = trimmed.startsWith(CARD_QR_PREFIX) ? trimmed.slice(CARD_QR_PREFIX.length) : trimmed;
  return body
    .toLowerCase()
    .split(/[\s,\-_.]+/)
    .filter(Boolean)
    .join(' ');
}

export function isValidCard(input: string): boolean {
  return validateMnemonic(normalizeCardWords(input), wordlist);
}

export function cardAccount(input: string) {
  const words = normalizeCardWords(input);
  if (!validateMnemonic(words, wordlist)) throw new Error('These words are not a valid recovery card');
  return mnemonicToAccount(words);
}

/** CARD factor data: raw ECDSA signature of the 32-byte hash (no EIP-191 prefix), as the contract expects. */
export async function cardSign(input: string, hash: Hex): Promise<Hex> {
  return cardAccount(input).sign({ hash });
}

export function cardQrPayload(mnemonic: string): string {
  return CARD_QR_PREFIX + normalizeCardWords(mnemonic).split(' ').join('-');
}

/** Short checksum shown on the card ("Card ID") to confirm the right card is used, without revealing words. */
export function cardId(address: string): string {
  return `${address.slice(2, 6)}-${address.slice(-4)}`.toUpperCase();
}
