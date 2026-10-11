import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Address, PublicClient } from 'viem';
import { ApiError, api, type Deployment, type NameBook } from '@rutli/sdk';
import { makeClient, readWallet, type WalletState } from './chain';
import {
  DEVICE_ID,
  getHolder,
  getPasskey,
  getPendingPasskey,
  load,
  save,
  setHolder as storeHolder,
  setPasskey as storePasskey,
  setPendingPasskey,
  type DevicePasskey,
  type Holder,
} from './device';
import { services, type Profile, type Services } from './services';
import { contacts } from './contacts';

export type LinkState = 'no-session' | 'loading' | 'no-wallet' | 'linked' | 'unlinked' | 'removed' | 'recovering';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'danger';
}

export interface AppCtx {
  cfg: Deployment;
  pc: PublicClient;
  svc: Services;
  token?: string;
  profile?: Profile;
  wallet?: WalletState;
  passkey?: DevicePasskey;
  link: LinkState;
  holder: Holder;
  names: NameBook;
  setHolder(h: Holder): void;
  login(): Promise<void>;
  logout(): void;
  refresh(): Promise<void>;
  setPasskey(p?: DevicePasskey): void;
  toast(text: string, kind?: Toast['kind']): void;
  toasts: Toast[];
}

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside provider');
  return c;
}

export const SQ_CORE_URL = (import.meta.env.VITE_SQ_CORE_URL as string | undefined) ?? 'http://localhost:4000';

export async function loadConfig(): Promise<Deployment> {
  return api<Deployment>(`${SQ_CORE_URL}/config`);
}

export function AppProvider({ cfg, children }: { cfg: Deployment; children: ReactNode }) {
  const pc = useMemo(() => makeClient(cfg), [cfg]);
  const [token, setToken] = useState<string | undefined>(() => load<string>('session'));
  const [profile, setProfile] = useState<Profile>();
  const [wallet, setWallet] = useState<WalletState>();
  const [passkey, setPasskeyState] = useState<DevicePasskey | undefined>(() => getPasskey());
  const [holder, setHolderState] = useState<Holder>(() => getHolder());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loaded, setLoaded] = useState(false);
  const svc = useMemo(() => services(cfg, token), [cfg, token]);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5200);
  }, []);

  const inflight = useRef<Promise<void> | null>(null);
  const refresh = useCallback(async () => {
    if (!token) return;
    // Serialize refreshes; a caller that awaits refresh() always gets state read after its own action.
    while (inflight.current) await inflight.current.catch(() => undefined);
    const run = (async () => {
      try {
        const p = await svc.me();
        setProfile(p);
        if (p.wallet) setWallet(await readWallet(pc, cfg, p.wallet.account));
        else setWallet(undefined);
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          save('session', undefined);
          setToken(undefined);
        }
      } finally {
        setLoaded(true);
      }
    })();
    inflight.current = run;
    try {
      await run;
    } finally {
      if (inflight.current === run) inflight.current = null;
    }
  }, [token, svc, pc, cfg]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (!inflight.current) void refresh();
    }, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  const login = useCallback(async () => {
    const r = await services(cfg).login(DEVICE_ID);
    save('session', r.token);
    setToken(r.token);
    setLoaded(false);
  }, [cfg]);

  const logout = useCallback(() => {
    save('session', undefined);
    setToken(undefined);
    setProfile(undefined);
    setWallet(undefined);
  }, []);

  const setPasskey = useCallback((p?: DevicePasskey) => {
    storePasskey(p);
    setPasskeyState(p);
  }, []);

  const setHolder = useCallback((h: Holder) => {
    storeHolder(h);
    setHolderState(h);
  }, []);

  // A passkey created during a delayed recovery becomes this device's passkey once the recovery executed.
  useEffect(() => {
    const pending = getPendingPasskey();
    if (pending && wallet?.deployed && pending.x.toLowerCase() === wallet.passkeyX.toLowerCase()) {
      storePasskey(pending);
      setPendingPasskey(undefined);
      setPasskeyState(pending);
    }
  }, [wallet]);

  let link: LinkState = 'loading';
  if (!token) link = 'no-session';
  else if (!loaded || !profile) link = 'loading';
  else if (!profile.wallet) link = 'no-wallet';
  else if (wallet && wallet.deployed) {
    const same = (p?: DevicePasskey) => !!p && p.x.toLowerCase() === wallet.passkeyX.toLowerCase() && p.y.toLowerCase() === wallet.passkeyY.toLowerCase();
    const pending = getPendingPasskey();
    if (same(passkey) || same(pending)) link = 'linked';
    else if (pending && wallet.pendingRecovery.executeAfter > 0 && pending.x.toLowerCase() === wallet.pendingRecovery.newPasskeyX.toLowerCase()) link = 'recovering';
    else if (passkey) link = 'removed';
    else link = 'unlinked';
  }

  const names: NameBook = useMemo(() => {
    const n: Record<string, string> = {
      [cfg.contracts.usdc.toLowerCase()]: 'USDC',
      [cfg.contracts.vault.toLowerCase()]: 'Helvetia Yield Vault',
      [cfg.contracts.scam.toLowerCase()]: 'FreeAirdrop contract',
      [cfg.addresses.omnibus.toLowerCase()]: 'my Swissquote account',
    };
    for (const c of contacts(cfg)) n[c.address.toLowerCase()] ??= c.name;
    if (profile?.wallet) n[profile.wallet.account.toLowerCase()] = 'my wallet';
    return { usdc: cfg.contracts.usdc, names: n };
  }, [cfg, profile?.wallet]);

  const value: AppCtx = {
    cfg,
    pc,
    svc,
    token,
    profile,
    wallet,
    passkey,
    link,
    holder,
    names,
    setHolder,
    login,
    logout,
    refresh,
    setPasskey,
    toast,
    toasts,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export type { Address };
