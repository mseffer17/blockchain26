import { bytesToHex, type Hex } from 'viem';
import { SoftPasskey, createPasskey, isPlatformAuthenticatorAvailable, signWithPasskey } from '@rutli/sdk';

/**
 * A browser profile simulates one phone. `?device=new-phone` gives a second, independent phone in the same
 * browser (its own passkey, session and storage), which makes the split-screen demo possible.
 */
const params = new URLSearchParams(window.location.search);
export const DEVICE_ID = params.get('device') ?? 'phone';
export const DEVICE_LABEL =
  DEVICE_ID === 'phone' ? 'Claire’s phone' : DEVICE_ID === 'new-phone' ? 'Claire’s new phone' : DEVICE_ID.replace(/-/g, ' ');

const k = (name: string) => `rutli:${DEVICE_ID}:${name}`;

export function load<T>(name: string, scope: 'device' | 'global' = 'device'): T | undefined {
  try {
    const raw = window.localStorage.getItem(scope === 'device' ? k(name) : `rutli:${name}`);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function save(name: string, value: unknown, scope: 'device' | 'global' = 'device') {
  try {
    const key = scope === 'device' ? k(name) : `rutli:${name}`;
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: the app still works for this session */
  }
}

export interface DevicePasskey {
  kind: 'platform' | 'soft';
  credentialId?: string;
  x: Hex;
  y: Hex;
  softKey?: Hex;
  createdAt: number;
}

export const getPasskey = () => load<DevicePasskey>('passkey');
export const setPasskey = (p: DevicePasskey | undefined) => save('passkey', p);

/** A passkey created for a delayed recovery (S+G): it becomes active once the recovery executes on-chain. */
export const getPendingPasskey = () => load<DevicePasskey>('pending-passkey');
export const setPendingPasskey = (p: DevicePasskey | undefined) => save('pending-passkey', p);

export async function platformAvailable(): Promise<boolean> {
  return isPlatformAuthenticatorAvailable();
}

/** Create this device's passkey: the real platform authenticator, or the labelled demo fallback. */
export async function createDevicePasskey(mode: 'platform' | 'soft', userName: string): Promise<DevicePasskey> {
  if (mode === 'platform') {
    const { credentialId, publicKey } = await createPasskey({
      rpId: window.location.hostname,
      rpName: 'Rütli by Swissquote (demo)',
      userName,
      userDisplayName: `${userName} — ${DEVICE_LABEL}`,
    });
    return { kind: 'platform', credentialId, x: publicKey.x, y: publicKey.y, createdAt: Date.now() };
  }
  const soft = new SoftPasskey(bytesToHex(crypto.getRandomValues(new Uint8Array(32))), window.location.hostname, window.location.origin);
  return { kind: 'soft', softKey: soft.privateKey, x: soft.publicKey.x, y: soft.publicKey.y, createdAt: Date.now() };
}

/** Face ID: sign a 32-byte challenge (a userOpHash) with this device's passkey. */
export async function deviceSign(p: DevicePasskey, challenge: Hex): Promise<Hex> {
  if (p.kind === 'platform') {
    return signWithPasskey({ credentialId: p.credentialId!, rpId: window.location.hostname, challenge });
  }
  await new Promise((r) => setTimeout(r, 450)); // the demo authenticator "scans" too
  return new SoftPasskey(p.softKey!, window.location.hostname, window.location.origin).sign(challenge);
}

/** Who is holding this phone right now (storytelling for the theft demo). */
export type Holder = 'claire' | 'mallory';
export const getHolder = (): Holder => load<Holder>('holder') ?? 'claire';
export const setHolder = (h: Holder) => save('holder', h);

/**
 * DEMO SHORTCUT ONLY. The recovery card is paper: in real life it is never stored on a device. To avoid
 * typing 12 words on stage, the words printed during onboarding are kept here and offered as a shortcut
 * clearly labelled as such.
 */
export interface DemoCard {
  address: string;
  words: string;
  createdAt: number;
}
export const demoCards = () => load<DemoCard[]>('demo-cards', 'global') ?? [];
export const rememberDemoCard = (c: DemoCard) => save('demo-cards', [c, ...demoCards().filter((x) => x.address !== c.address)].slice(0, 5), 'global');
