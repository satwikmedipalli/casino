import type { CSSProperties } from 'react';
import type { Card } from '../shared/types';
import { fmt } from '../shared/types';

const SUIT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

type Style = CSSProperties & Record<`--${string}`, string | number>;

export function CardView({ card, width, className = '', style, wild }: {
  card: Card | null; width: number; className?: string; style?: Style; wild?: boolean;
}) {
  const s: Style = { '--w': `${width}px`, ...style };
  if (!card) return <div className={`card back ${className}`} style={s} />;
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = SUIT[card[1]];
  const red = card[1] === 'h' || card[1] === 'd';
  return (
    <div className={`card face ${red ? 'red' : ''} ${wild ? 'wild' : ''} ${className}`} style={s}>
      <span className="corner">{rank}<small>{suit}</small></span>
      <span className="pip">{suit}</span>
    </div>
  );
}

/** A card that turns over in 3D. Used for your own cards so you can peek at them. */
export function FlipCard({ card, up, width, wild }: { card: Card | null; up: boolean; width: number; wild?: boolean }) {
  return (
    <div className={`flip ${up ? 'up' : ''}`} style={{ '--w': `${width}px` } as Style}>
      <div className="flip-inner">
        <CardView card={null} width={width} />
        <div className="flip-front"><CardView card={card} width={width} wild={wild} /></div>
      </div>
    </div>
  );
}

// Denominations in cents, biggest first.
const DENOMS: [number, string][] = [
  [10000, '#e39a2d'], [2500, '#d1468c'], [500, '#6b3fb3'], [100, '#1c1c1c'],
  [25, '#1e8a4c'], [5, '#c23434'], [1, '#e9e6df'],
];

function discs(amount: number): string[] {
  const out: string[] = [];
  let left = amount;
  for (const [value, color] of DENOMS) {
    while (left >= value && out.length < 10) { out.push(color); left -= value; }
  }
  return out;
}

export function ChipStack({ amount, className = '', style, label }: {
  amount: number; className?: string; style?: Style; label?: string;
}) {
  const ds = discs(amount);
  return (
    <div className={`stack ${className}`} style={style}>
      <div className="discs" style={{ '--n': ds.length } as Style}>
        {ds.map((c, i) => <span key={i} className="chip" style={{ '--c': c, bottom: i * 3 } as Style} />)}
      </div>
      <span className="amt">{label ? `${label} ` : ''}{fmt(amount)}</span>
    </div>
  );
}
