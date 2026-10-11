import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApp } from '../lib/app';
import { go } from '../lib/route';
import { Addr, Header } from '../components/ui';

export function Receive() {
  const { wallet, cfg } = useApp();
  const [qr, setQr] = useState<string>();
  useEffect(() => {
    if (wallet) void QRCode.toDataURL(wallet.account, { margin: 1, width: 240 }).then(setQr);
  }, [wallet?.account]);
  if (!wallet) return null;
  return (
    <div className="screen receive">
      <Header title="Receive" back={() => go('/')} />
      <div className="center">{qr && <img src={qr} alt="Wallet address QR code" className="qr" />}</div>
      <Addr value={wallet.account} full />
      <p className="muted">
        USDC on {cfg.network === 'local' ? 'the local test chain' : 'Base Sepolia'} only. Anyone can send to this address; it is the same after
        any recovery.
      </p>
    </div>
  );
}
