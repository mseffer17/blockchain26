import type { ReactNode } from 'react';

export type KeyState = 'idle' | 'required' | 'signed' | 'refused';
export type KeyId = 'P' | 'C' | 'S' | 'G';

/**
 * The pact seal: four keys around a ring. The left half belongs to the client (Face ID, card), the right
 * half to the institutions (Swissquote, La Poste). An arc lights up when that key signs.
 */
const ARCS: Record<KeyId, { from: number; to: number; label: string; side: 'client' | 'institution'; lx: number; ly: number; anchor: 'start' | 'end' }> = {
  P: { from: 275, to: 355, label: 'Face ID', side: 'client', lx: 18, ly: 14, anchor: 'start' },
  S: { from: 5, to: 85, label: 'Swissquote', side: 'institution', lx: 142, ly: 14, anchor: 'end' },
  G: { from: 95, to: 175, label: 'La Poste', side: 'institution', lx: 142, ly: 152, anchor: 'end' },
  C: { from: 185, to: 265, label: 'Card', side: 'client', lx: 18, ly: 152, anchor: 'start' },
};

function polar(cx: number, cy: number, r: number, deg: number) {
  const rad = ((deg - 90) * Math.PI) / 180; // 0° = top, clockwise
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const a = polar(cx, cy, r, from);
  const b = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export function Seal({
  states,
  size = 160,
  labels = true,
  center,
  title,
}: {
  states: Partial<Record<KeyId, KeyState>>;
  size?: number;
  labels?: boolean;
  center?: ReactNode;
  title?: string;
}) {
  const cx = 80;
  const cy = 83;
  const r = 50;
  return (
    <svg className="seal" width={size} height={size} viewBox="0 0 160 166" role="img" aria-label={title ?? 'Signature seal'}>
      <circle cx={cx} cy={cy} r={r} className="seal-track" />
      {(Object.keys(ARCS) as KeyId[]).map((id) => {
        const a = ARCS[id];
        const st = states[id] ?? 'idle';
        return (
          <g key={id} className={`seal-key seal-${st} seal-${a.side}`}>
            <path d={arcPath(cx, cy, r, a.from, a.to)} pathLength={100} className="seal-arc" />
            {labels && (
              <text x={a.lx} y={a.ly} textAnchor={a.anchor} className="seal-label">
                {a.label}
              </text>
            )}
          </g>
        );
      })}
      <foreignObject x={cx - 34} y={cy - 22} width={68} height={44}>
        <div className="seal-center">{center}</div>
      </foreignObject>
    </svg>
  );
}
