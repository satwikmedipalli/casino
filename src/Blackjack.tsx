import { useEffect, useRef, useState } from 'react';
import { fmt } from '../shared/types';
import type { BJHandView, BJResult, BJView, ClientMsg, SeatView, TableView } from '../shared/types';
import { CardView } from './Card';
import { sfx } from './sound';

const RESULT: Record<BJResult, string> = { blackjack: 'Blackjack!', win: 'Win', push: 'Push', lose: 'Lose', bust: 'Bust' };
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `−${fmt(-n)}` : 'even');

/** "7/17" while an Ace can still count either way. */
function totalLabel(h: BJHandView) {
  return h.soft && h.total < 21 ? `${h.total - 10}/${h.total}` : `${h.total}`;
}

function cardCount(bj: BJView) {
  return bj.dealer.filter(Boolean).length + bj.players.reduce((t, y) => t + y.hands.reduce((u, h) => u + h.cards.length, 0), 0);
}

/** Card sounds as cards hit the table, and a chime when it's your move. */
export function useBlackjackSounds(bj: BJView | null, you: string) {
  const prev = useRef<BJView | null>(null);
  useEffect(() => {
    const before = prev.current;
    prev.current = bj;
    if (!bj || !before) return;
    const added = cardCount(bj) - cardCount(before);
    if (added > 0) sfx.flip(Math.min(added, 4));
    if (bj.active?.id === you && (before.active?.id !== you || before.active.hand !== bj.active.hand)) sfx.turn();
    if (bj.step === 'done' && before.step !== 'done') {
      const mine = bj.bankerId === you ? bj.bankNet : bj.players.find(y => y.id === you)?.net;
      if ((mine ?? 0) > 0) setTimeout(() => sfx.win(), 400);
    }
  }, [bj]);
}

/** The bank's cards in the middle of the table. */
export function BJDealer({ bj, bankName, width, x, y }: { bj: BJView; bankName: string; width: number; x: number; y: number }) {
  const bust = (bj.dealerTotal ?? 0) > 21;
  return (
    <div className="board bj-dealer" style={{ left: x, top: y }}>
      <span className="board-label">BANK · {bankName.toUpperCase()}</span>
      {bj.dealer.length === 0
        ? [0, 1].map(i => <div key={i} className="slot" style={{ width, height: width * 1.4 }} />)
        : bj.dealer.map((c, i) => <CardView key={`${i}-${c ?? 'down'}`} card={c} width={width} className="flip-in" />)}
      {bj.dealerTotal != null && <span className={`bj-total ${bust ? 'bust' : ''}`}>{bust ? `Bust ${bj.dealerTotal}` : bj.dealerTotal}</span>}
    </div>
  );
}

function HandRow({ h, width, overlap, active }: { h: BJHandView; width: number; overlap: number; active: boolean }) {
  return (
    <div className={`bj-hand ${active ? 'active' : ''} ${h.result ? `r-${h.result}` : ''}`}>
      <div className="bj-cards">
        {h.cards.map((c, i) => (
          <CardView key={`${i}-${c}`} card={c} width={width} className="flip-in" style={{ marginLeft: i ? -width * overlap : 0 }} />
        ))}
      </div>
      <span className="bj-total">{h.result ? RESULT[h.result] : totalLabel(h)}{h.doubled ? ' ×2' : ''}</span>
    </div>
  );
}

/** Another player's hands, face up, shown above their seat. */
export function BJSeatHands({ bj, id, width }: { bj: BJView; id: string; width: number }) {
  const y = bj.players.find(z => z.id === id);
  if (!y || !y.hands.length || !y.hands[0].cards.length) return null;
  return (
    <div className="bj-seat-hands">
      {y.hands.map((h, k) => (
        <HandRow key={k} h={h} width={width} overlap={0.55} active={bj.active?.id === id && bj.active.hand === k} />
      ))}
    </div>
  );
}

/** Your own hands, big, under the table. */
export function BJMyHands({ bj, you }: { bj: BJView; you: string }) {
  if (bj.bankerId === you) {
    return (
      <div className="bj-mine">
        <div className="my-hand-name">You're the bank this round</div>
        {bj.bankNet !== undefined && <div className={`bj-net-big ${bj.bankNet >= 0 ? 'up' : 'down'}`}>{signed(bj.bankNet)}</div>}
      </div>
    );
  }
  const y = bj.players.find(z => z.id === you);
  if (!y) return <div className="bj-mine"><div className="my-hand-name">Not enough chips for this round</div></div>;
  if (y.bet === 0) return <div className="bj-mine"><div className="my-hand-name">Sitting this round out</div></div>;
  if (!y.hands.length || !y.hands[0].cards.length) {
    return <div className="bj-mine"><div className="my-hand-name">{y.bet ? `You bet ${fmt(y.bet)}` : 'Place your bet'}</div></div>;
  }
  const many = y.hands.length > 1;
  const width = Math.min(window.innerWidth > 700 ? 84 : 66, Math.floor((Math.min(window.innerWidth, 560) - 40) / (y.hands.length * 2.2)));
  return (
    <div className="bj-mine">
      <div className="bj-my-hands">
        {y.hands.map((h, k) => (
          <div key={k} className="bj-my-hand">
            <HandRow h={h} width={width} overlap={0.35} active={many && bj.active?.id === you && bj.active.hand === k} />
            <span className="bj-bet">{fmt(h.bet)}</span>
          </div>
        ))}
      </div>
      {y.net !== undefined && <div className={`bj-net-big ${y.net >= 0 ? 'up' : 'down'}`}>{signed(y.net)}</div>}
      {y.insurance ? <div className="muted center">Insured for {fmt(y.insurance)}</div> : null}
    </div>
  );
}

/** Results for everyone once the round settles. */
export function BJBanner({ bj, seats, you }: { bj: BJView; seats: SeatView[]; you: string }) {
  const name = (id: string) => (id === you ? 'You' : seats.find(x => x.id === id)?.name ?? '?');
  const rows = bj.players.filter(y => y.net !== undefined).map(y => [y.id, y.net!] as const);
  return (
    <div className="table-banner win bj-banner">
      {[...rows, [bj.bankerId, bj.bankNet ?? 0] as const].map(([id, net]) => (
        <span key={id} className={net > 0 ? 'up' : net < 0 ? 'down' : ''}>
          {name(id)}{id === bj.bankerId ? ' (bank)' : ''} {signed(net)}
        </span>
      ))}
    </div>
  );
}

export function BJActions({ s, bj, me, send }: { s: TableView; bj: BJView; me?: SeatView; send: (m: ClientMsg) => void }) {
  const y = bj.players.find(z => z.id === s.you);
  const chips = me?.chips ?? 0;
  const top = Math.min(bj.max, chips);
  const [amount, setAmount] = useState(bj.min);
  useEffect(() => setAmount(bj.min), [s.handNo, bj.min]);
  const nameOf = (id: string) => s.seats.find(x => x.id === id)?.name ?? '?';
  const status = (text: string) => <div className="actions"><div className="status">{text}</div></div>;

  if (me && chips === 0 && !(y && y.bet && bj.step !== 'done')) {
    return (
      <div className="actions">
        <button className="btn primary" onClick={() => send({ t: 'rebuy' })}>Rebuy {fmt(s.startingChips)}</button>
      </div>
    );
  }

  if (bj.step === 'bet' && y && y.bet === null) {
    const clamp = (v: number) => Math.max(bj.min, Math.min(top, Math.round(v / s.blinds.sb) * s.blinds.sb));
    const quick: [string, number][] = [['Min', bj.min], ['×2', clamp(bj.min * 2)], ['×5', clamp(bj.min * 5)], ['Max', top]];
    return (
      <div className="actions raise-panel">
        <div className="row quick">
          {quick.map(([label, v]) => (
            <button key={label} className={`chip-btn ${amount === v ? 'on' : ''}`} onClick={() => setAmount(v)}>{label}</button>
          ))}
        </div>
        {top > bj.min && (
          <input type="range" min={bj.min} max={top} step={s.blinds.sb} value={amount}
            onChange={e => setAmount(clamp(Number(e.target.value)))} />
        )}
        <div className="row">
          <button className="btn" onClick={() => send({ t: 'bj_bet', amount: 0 })}>Sit out</button>
          <button className="btn primary" style={{ flex: 2 }} onClick={() => send({ t: 'bj_bet', amount: clamp(amount) })}>
            Bet {fmt(clamp(amount))}
          </button>
        </div>
      </div>
    );
  }

  if (bj.step === 'insurance' && y && y.insurance === null) {
    return (
      <div className="actions">
        <div className="status">The bank shows an Ace. Insure against blackjack? Pays 2 to 1.</div>
        <div className="row">
          <button className="btn" onClick={() => send({ t: 'bj_insure', take: false })}>No thanks</button>
          <button className="btn primary" onClick={() => send({ t: 'bj_insure', take: true })}>Insure {fmt(bj.insuranceCost)}</button>
        </div>
      </div>
    );
  }

  if (bj.step === 'play' && bj.active?.id === s.you && y) {
    const many = y.hands.length > 1;
    return (
      <div className="actions">
        {many && <div className="status">Hand {bj.active.hand + 1} of {y.hands.length}</div>}
        <div className="row">
          <button className="btn call" onClick={() => send({ t: 'bj_act', action: 'hit' })}>Hit</button>
          <button className="btn fold" onClick={() => send({ t: 'bj_act', action: 'stand' })}>Stand</button>
        </div>
        {(bj.canDouble || bj.canSplit) && (
          <div className="row">
            {bj.canDouble && <button className="btn raise" onClick={() => send({ t: 'bj_act', action: 'double' })}>Double</button>}
            {bj.canSplit && <button className="btn raise" onClick={() => send({ t: 'bj_act', action: 'split' })}>Split</button>}
          </div>
        )}
      </div>
    );
  }

  if (bj.step === 'bet') {
    const waiting = bj.players.filter(z => z.bet === null).map(z => nameOf(z.id));
    return status(waiting.length ? `Waiting for bets: ${waiting.join(', ')}…` : 'Dealing…');
  }
  if (bj.step === 'insurance') return status('Players are deciding on insurance…');
  if (bj.step === 'play' && bj.active) return status(`${nameOf(bj.active.id)} is playing…`);
  if (bj.step === 'bank') return status('The bank is drawing…');
  return status(s.log[s.log.length - 1] ?? '');
}
