import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { Hex } from 'viem';
import {
  cardAccount,
  cardId,
  cardQrPayload,
  formatUsdc,
  generateCardMnemonic,
  ownershipChallenge,
  rutliFactoryAbi,
} from '@rutli/sdk';
import { useApp } from '../lib/app';
import { createDevicePasskey, deviceSign, platformAvailable, rememberDemoCard, type DevicePasskey } from '../lib/device';
import { go } from '../lib/route';
import { Seal } from '../components/Seal';
import { Button, Notice, errorText } from '../components/ui';

type Step = 'intro' | 'passkey' | 'card' | 'activate';

export function Onboarding() {
  const app = useApp();
  const { cfg, svc, pc, profile } = app;
  const [step, setStep] = useState<Step>('intro');
  const [pk, setPk] = useState<DevicePasskey>();
  const [words] = useState(() => generateCardMnemonic());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [hasPlatform, setHasPlatform] = useState<boolean | null>(null);

  useEffect(() => {
    void platformAvailable().then(setHasPlatform);
  }, []);

  const createPk = async (mode: 'platform' | 'soft') => {
    setBusy(true);
    setError(undefined);
    try {
      setPk(await createDevicePasskey(mode, profile?.email ?? 'claire'));
      setStep('card');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!pk) return;
    setBusy(true);
    setError(undefined);
    try {
      const prep = await svc.prepare();
      const card = cardAccount(words).address;
      const cfgBody = {
        passkeyX: pk.x,
        passkeyY: pk.y,
        card,
        cosigner: prep.cosigner,
        guardian: prep.guardian,
        recoveryDelay: prep.recoveryDelay,
        exitDelay: prep.exitDelay,
        allowanceTokens: prep.allowanceTokens,
        allowanceLimits: prep.allowanceLimits,
      };
      const addr = await pc.readContract({
        address: cfg.contracts.factory,
        abi: rutliFactoryAbi,
        functionName: 'getAddress',
        args: [{ ...cfgBody, allowanceLimits: cfgBody.allowanceLimits.map(BigInt) }, prep.salt],
      });
      const challenge = ownershipChallenge({ clientId: profile!.id, account: addr, chainId: cfg.chainId, nonce: prep.ownershipNonce });
      const proof: Hex = await deviceSign(pk, challenge);
      await svc.activate(cfgBody, proof);
      app.setPasskey(pk);
      rememberDemoCard({ address: card, words, createdAt: Date.now() });
      app.toast('Wallet created and verified for the Travel Rule', 'success');
      go('/bank');
      await app.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen onboarding">
      {step === 'intro' && (
        <>
          <h1 className="display">Your own wallet, with a pact</h1>
          <div className="center">
            <Seal states={{}} size={180} />
          </div>
          <ul className="pact-intro">
            <li>
              <strong>Face ID</strong> on this phone pays up to {formatUsdc(BigInt(cfg.params.dailyLimitUsdc), { decimals: 0 })} USDC a day.
            </li>
            <li>
              Your <strong>vault</strong> needs a second key: Swissquote, or your paper card.
            </li>
            <li>
              Lost everything? <strong>Swissquote and La Poste</strong> can restore access, after a public delay that you can cancel.
            </li>
            <li>Swissquote can never move your money, alone or with anyone else.</li>
          </ul>
          <Button onClick={() => setStep('passkey')}>Create my wallet</Button>
        </>
      )}

      {step === 'passkey' && (
        <>
          <p className="step-index">Step 1 of 3</p>
          <h1 className="display">Create your passkey</h1>
          <p className="lead">
            A key generated inside this phone’s secure chip, unlocked by Face ID. It never leaves the phone; Swissquote only sees its public
            half.
          </p>
          {hasPlatform === false && (
            <Notice kind="info" title="No Face ID / Touch ID on this computer">
              Use the demo authenticator: it produces the same signatures, with a key kept in this browser.
            </Notice>
          )}
          {error && <Notice kind="danger">{error}</Notice>}
          <Button busy={busy} disabled={hasPlatform === false} onClick={() => void createPk('platform')}>
            Create with Face ID / Touch ID
          </Button>
          <Button kind="secondary" busy={busy} onClick={() => void createPk('soft')}>
            Use the demo authenticator
          </Button>
        </>
      )}

      {step === 'card' && <CardStep words={words} onNext={() => setStep('activate')} />}

      {step === 'activate' && (
        <>
          <p className="step-index">Step 3 of 3</p>
          <h1 className="display">Link it to your Swissquote account</h1>
          <p className="lead">
            Face ID signs a statement that this wallet is yours. That is the Travel Rule ownership check, done once, by cryptography: no
            screenshot, no test transfer, no waiting.
          </p>
          <div className="keys-summary">
            <div>
              <span className="muted small">Your passkey</span>
              <span>{pk?.kind === 'platform' ? 'Face ID (this phone)' : 'Demo authenticator (this browser)'}</span>
            </div>
            <div>
              <span className="muted small">Your card</span>
              <span>Card {cardId(cardAccount(words).address)}</span>
            </div>
            <div>
              <span className="muted small">Second key</span>
              <span>Swissquote co-signer</span>
            </div>
            <div>
              <span className="muted small">Independent guardian</span>
              <span>La Poste</span>
            </div>
          </div>
          {error && <Notice kind="danger">{error}</Notice>}
          <Button busy={busy} onClick={() => void activate()}>
            Sign with Face ID and create my wallet
          </Button>
        </>
      )}

    </div>
  );
}

function CardStep({ words, onNext }: { words: string; onNext: () => void }) {
  const [qr, setQr] = useState<string>();
  const [checked, setChecked] = useState(false);
  const [w3, setW3] = useState('');
  const [w9, setW9] = useState('');
  const list = words.split(' ');
  const address = cardAccount(words).address;
  useEffect(() => {
    void QRCode.toDataURL(cardQrPayload(words), { margin: 1, width: 220, errorCorrectionLevel: 'M' }).then(setQr);
  }, [words]);
  const confirmed = w3.trim().toLowerCase() === list[2] && w9.trim().toLowerCase() === list[8];
  return (
    <>
      <p className="step-index">Step 2 of 3</p>
      <h1 className="display">Print your recovery card</h1>
      <p className="lead">
        Your second key, on paper. Keep it at home, never photograph it. On its own it can only freeze your wallet or start a slow exit.
      </p>
      <div className="paper-card" id="printable-card">
        <div className="paper-card-head">
          <span className="paper-card-brand">Rütli recovery card</span>
          <span className="paper-card-id">Card {cardId(address)}</span>
        </div>
        <div className="paper-card-body">
          {qr && <img src={qr} alt="QR code of the recovery card" className="paper-card-qr" />}
          <ol className="paper-card-words">
            {list.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ol>
        </div>
        <p className="paper-card-foot">Alone: freeze, cancel a recovery, or start a 30-day exit. With Face ID: full control.</p>
      </div>
      <Button kind="secondary" onClick={() => window.print()}>
        Print the card
      </Button>
      <div className="confirm-words">
        <p className="small">Check your copy: type words 3 and 9.</p>
        <div className="row">
          <input className="input" placeholder="Word 3" value={w3} onChange={(e) => setW3(e.target.value)} autoCapitalize="none" />
          <input className="input" placeholder="Word 9" value={w9} onChange={(e) => setW9(e.target.value)} autoCapitalize="none" />
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> Skip the check (demo)
        </label>
      </div>
      <Button disabled={!confirmed && !checked} onClick={onNext}>
        I have my card
      </Button>
    </>
  );
}
