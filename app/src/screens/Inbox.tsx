import { useApp } from '../lib/app';
import { go } from '../lib/route';
import { Header } from '../components/ui';

export function Inbox() {
  const { profile } = useApp();
  const items = profile?.notifications ?? [];
  return (
    <div className="screen inbox">
      <Header title="Inbox" back={() => go('/')} />
      {items.length === 0 && <p className="muted">Nothing yet. Security alerts from the watchtower appear here, and by e-mail and SMS.</p>}
      <ul className="notes">
        {items.map((n) => (
          <li key={n.id} className={`note note-${n.level}`}>
            <div className="note-head">
              <strong>{n.title}</strong>
              <time>{new Date(n.at).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
            </div>
            <p>{n.body}</p>
            <span className="note-channels">Sent to: {n.channels.join(', ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
