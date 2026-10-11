import { useState } from 'react';
import { useApp } from '../lib/app';
import { DEVICE_LABEL } from '../lib/device';
import { Button, Field, Notice, errorText } from '../components/ui';

export function Splash() {
  return (
    <div className="splash">
      <div className="wordmark">Rütli</div>
    </div>
  );
}

/** MOCK of Swissquote's existing login (password + 2FA). The wallet never relies on this session for security. */
export function Login() {
  const { login } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <div className="screen login">
      <div className="wordmark big">Rütli</div>
      <p className="lead">Your keys, your vault — one step from your Swissquote account.</p>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await login();
          } catch (err) {
            setError(errorText(err));
            setBusy(false);
          }
        }}
      >
        <Field label="Swissquote client">
          <input className="input" value="claire" readOnly />
        </Field>
        <Field label="Password" hint="Demo login. In production: your usual Swissquote login and 2FA.">
          <input className="input" type="password" value="demo" readOnly />
        </Field>
        {error && <Notice kind="danger">{error}</Notice>}
        <Button type="submit" busy={busy}>
          Log in on {DEVICE_LABEL}
        </Button>
      </form>
    </div>
  );
}
