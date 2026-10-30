import type { CSSProperties } from 'react';
import type { Card } from '../shared/types';
import { fmt } from '../shared/types';

const SUIT: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

type Style = CSSProperties & Record<`--${string}`, string | number>;

// Pip positions (percent of the pip area) for 2-10, like a real deck.
const PIPS: Record<string, [number, number][]> = {
  '2': [[50, 0], [50, 100]],
  '3': [[50, 0], [50, 50], [50, 100]],
  '4': [[22, 0], [78, 0], [22, 100], [78, 100]],
  '5': [[22, 0], [78, 0], [50, 50], [22, 100], [78, 100]],
  '6': [[22, 0], [78, 0], [22, 50], [78, 50], [22, 100], [78, 100]],
  '7': [[22, 0], [78, 0], [50, 25], [22, 50], [78, 50], [22, 100], [78, 100]],
  '8': [[22, 0], [78, 0], [50, 25], [22, 50], [78, 50], [50, 75], [22, 100], [78, 100]],
  '9': [[22, 0], [78, 0], [22, 33], [78, 33], [50, 50], [22, 67], [78, 67], [22, 100], [78, 100]],
  T: [[22, 0], [78, 0], [50, 17], [22, 33], [78, 33], [22, 67], [78, 67], [50, 83], [22, 100], [78, 100]],
};
const COURT: Record<string, string> = { K: '\u265A\uFE0E', Q: '\u265B\uFE0E', J: '\u265D\uFE0E' };
const DETAILED = 58; // below this width a card shows just the index and one big suit

export function CardView({ card, width, className = '', style, wild }: {
  card: Card | null; width: number; className?: string; style?: Style; wild?: boolean;
}) {
  const s: Style = { '--w': `${width}px`, ...style };
  if (!card) return <div className={`card back ${className}`} style={s}><span className="emblem">♠</span></div>;
  const r = card[0];
  const rank = r === 'T' ? '10' : r;
  const suit = SUIT[card[1]];
  const red = card[1] === 'h' || card[1] === 'd';
  const detailed = width >= DETAILED;
  const index = (pos: string) => <span className={`idx ${pos}`}>{rank}<i>{suit}</i></span>;
  let body;
  if (!detailed) body = <span className="pip-solo">{suit}</span>;
  else if (r === 'A') body = <span className="ace">{suit}</span>;
  else if (COURT[r]) {
    body = (
      <span className="court">
        <span className="crown">{COURT[r]}</span>
        <span className="court-rank">{rank}</span>
        <span className="court-suit">{suit}</span>
      </span>
    );
  } else {
    body = (
      <span className="pips">
        {PIPS[r].map(([x, y], i) => <span key={i} className={y > 50 ? 'down' : ''} style={{ left: `${x}%`, top: `${y}%` }}>{suit}</span>)}
      </span>
    );
  }
  return (
    <div className={`card face ${red ? 'red' : ''} ${wild ? 'wild' : ''} ${detailed ? 'big' : ''} ${className}`} style={s}>
      {index('tl')}
      {detailed && index('br')}
      {body}
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
