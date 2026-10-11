import { useEffect, useState, type ReactNode } from 'react';
import type { Deployment } from '@rutli/sdk';
import { AppProvider, loadConfig, useApp } from './lib/app';
import { DEVICE_LABEL } from './lib/device';
import { go, useRoute } from './lib/route';
import { Toasts } from './components/ui';
import { Login, Splash } from './screens/Login';
import { Onboarding } from './screens/Onboarding';
import { Home } from './screens/Home';
import { Send } from './screens/Send';
import { Receive } from './screens/Receive';
import { Bank } from './screens/Bank';
import { Dapps } from './screens/Dapps';
import { Security } from './screens/Security';
import { Inbox } from './screens/Inbox';
import { Recover, Recovering, Removed } from './screens/Recover';
import { Mailbox } from './screens/Mailbox';
import { Ops } from './screens/Ops';

export function App() {
  const [cfg, setCfg] = useState<Deployment>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stop = false;
    const tryLoad = () =>
      loadConfig()
        .then((c) => !stop && setCfg(c))
        .catch(() => {
          if (stop) return;
          setError('Waiting for the Swissquote services on http://localhost:4000 — run "npm run dev" in the project folder.');
          setTimeout(tryLoad, 2000);
        });
    tryLoad();
    return () => {
      stop = true;
    };
  }, []);
  if (!cfg) return <div className="boot">{error ?? 'Loading…'}</div>;
  return (
    <AppProvider cfg={cfg}>
      <Router />
    </AppProvider>
  );
}

function Router() {
  const route = useRoute();
  if (route.startsWith('/mailbox')) return <Mailbox />;
  if (route.startsWith('/ops')) return <Ops />;
  return (
    <PhoneFrame route={route}>
      <PhoneRoutes route={route} />
    </PhoneFrame>
  );
}

function PhoneRoutes({ route }: { route: string }) {
  const { link } = useApp();
  if (link === 'no-session') return <Login />;
  if (link === 'loading') return <Splash />;
  if (link === 'no-wallet') return <Onboarding />;
  if (link === 'unlinked') return <Recover />;
  if (link === 'recovering') return <Recovering />;
  if (link === 'removed') return <Removed />;
  switch (route) {
    case '/send':
      return <Send />;
    case '/receive':
      return <Receive />;
    case '/bank':
      return <Bank />;
    case '/dapps':
      return <Dapps />;
    case '/security':
      return <Security />;
    case '/inbox':
      return <Inbox />;
    default:
      return <Home />;
  }
}

const TABS: Array<{ path: string; label: string; icon: ReactNode }> = [
  {
    path: '/',
    label: 'Wallet',
    icon: <path d="M4 7h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7zm0 0l2-3h10M16 13h.01" />,
  },
  { path: '/send', label: 'Send', icon: <path d="M5 12h12M13 6l6 6-6 6" /> },
  {
    path: '/security',
    label: 'Security',
    icon: <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />,
  },
  {
    path: '/inbox',
    label: 'Inbox',
    icon: <path d="M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5a3 3 0 0 0 6 0h5" />,
  },
];

function PhoneFrame({ children, route }: { children: ReactNode; route: string }) {
  const { link, holder, setHolder, profile } = useApp();
  const unread = profile?.notifications.length ?? 0;
  const showTabs = link === 'linked';
  return (
    <div className="stage">
      <div className="device-caption">
        <span className="device-name">{DEVICE_LABEL}</span>
        <span className={`holder holder-${holder}`}>
          held by{' '}
          <select value={holder} onChange={(e) => setHolder(e.target.value as 'claire' | 'mallory')} aria-label="Who holds this phone (demo)">
            <option value="claire">Claire</option>
            <option value="mallory">Mallory, the thief</option>
          </select>
        </span>
      </div>
      <div className={`phone holder-${holder}`}>
        <div className="phone-status">
          <span>Rütli</span>
          <span className="phone-status-right">Swissquote session (demo)</span>
        </div>
        <main className="phone-body">{children}</main>
        {showTabs && (
          <nav className="tabbar" aria-label="Main">
            {TABS.map((t) => {
              const active = t.path === '/' ? route === '/' || route === '' : route.startsWith(t.path);
              return (
                <button key={t.path} type="button" className={`tab${active ? ' is-active' : ''}`} onClick={() => go(t.path)}>
                  <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    {t.icon}
                  </svg>
                  <span>{t.label}</span>
                  {t.path === '/inbox' && unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
                </button>
              );
            })}
          </nav>
        )}
        <Toasts />
      </div>
      <div className="stage-links">
        <a href="/?device=new-phone" target="_blank" rel="noreferrer">
          Open a second phone
        </a>
        <a href="/#/mailbox" target="_blank" rel="noreferrer">
          Claire’s mailbox
        </a>
        <a href="/#/ops" target="_blank" rel="noreferrer">
          Back-office
        </a>
        <a href="http://localhost:5174" target="_blank" rel="noreferrer">
          Exit app
        </a>
      </div>
    </div>
  );
}
