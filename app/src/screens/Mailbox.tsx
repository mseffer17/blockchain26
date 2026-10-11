import { useEffect, useState } from 'react';
import { useApp } from '../lib/app';
import type { Services } from '../lib/services';

type Box = Awaited<ReturnType<Services['mailbox']>>;

/** DEMO: Claire's physical mailbox at home. Only the resident can open it — that is the point. */
export function Mailbox() {
  const { svc } = useApp();
  const [box, setBox] = useState<Box>();
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const boxes = await svc.mailboxes();
        const mine = boxes.find((b) => b.owner === 'Claire Dubois') ?? boxes[0];
        if (mine && !stop) setBox(await svc.mailbox(mine.id));
      } catch {
        /* La Poste not reachable */
      }
    };
    void load();
    const t = setInterval(load, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [svc]);

  return (
    <div className="page mailbox">
      <header className="page-header">
        <h1>Claire’s mailbox</h1>
        <p className="muted">{box ? box.address : 'Avenue de la Gare 12, 1003 Lausanne'}</p>
        <p className="small muted">Demo view of a physical mailbox. A thief holding Claire’s phone and e-mail cannot open it.</p>
      </header>
      {!box?.letters.length && <p className="muted">No mail. La Poste writes here when someone asks to recover Claire’s wallet.</p>}
      <div className="letters">
        {box?.letters.map((l) => (
          <article key={l.id} className="letter">
            <div className="letter-from">{l.from}</div>
            <div className="letter-date">Lausanne, {new Date(l.at).toLocaleString('fr-CH')}</div>
            <h2 className="letter-subject">{l.subject}</h2>
            {l.lines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            <div className="letter-code">
              <span>Code</span>
              <strong>{l.code}</strong>
            </div>
            <div className="letter-ref">Dossier {l.caseRef}, La Poste (mock partner)</div>
          </article>
        ))}
      </div>
    </div>
  );
}
