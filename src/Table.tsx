import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GAMES, SPLITS, fmt, isAK47Wild } from '../shared/types';
import type { Card, ClientMsg, SeatView, TableView } from '../shared/types';
import { CardView, ChipStack, FlipCard } from './Card';
import type { Poker } from './net';
import { sfx } from './sound';

type Pt = { x: number; y: number };
type Vars = React.CSSProperties & Record<`--${string}`, string | number>;
interface Ghost { key: string; amount: number; from: Pt; to: Pt; delay: number }

const RATIO = 0.62; // table width / height (portrait oval)
const SWIPE = 60;

const gameName = (id: string | null) => GAMES.find(g => g.id === id)?.name ?? 'Poker Night';
const initials = (name: string) => name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();

async function shareTable(code: string, toast: (m: string) => void) {
  const url = `${location.origin}/?code=${code}`;
  try {
    if (navigator.share) await navigator.share({ title: 'Poker Night', text: `Join my poker table. Code: ${code}`, url });
    else { await navigator.clipboard.writeText(url); toast('Link copied'); }
  } catch { /* cancelled */ }
}

export function Table({ poker }: { poker: Poker }) {
  const s = poker.state!;
  const send = poker.send;
  const [toast, setToast] = useState<string | null>(null);
  const shownToast = poker.error ?? toast;
  useEffect(() => {
    if (!shownToast) return;
    const t = setTimeout(() => { poker.clearError(); setToast(null); }, 2500);
    return () => clearTimeout(t);
  }, [shownToast]);

  // ---- table size ----
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 280, h: 280 / RATIO });
  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const measure = () => {
      const W = el.clientWidth - 70;
      const H = el.clientHeight - 96;
      const w = Math.max(180, Math.min(W, H * RATIO));
      setSize({ w, h: w / RATIO });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- seat geometry: you are always at the bottom, others go clockwise ----
  const meIndex = Math.max(0, s.seats.findIndex(x => x.id === s.you));
  const ids = s.seats.map(x => x.id).join(',');
  const geo = useMemo(() => {
    const n = s.seats.length;
    const cx = size.w / 2, cy = size.h / 2, rx = size.w / 2, ry = size.h / 2;
    const map = new Map<string, { seat: Pt; bet: Pt; button: Pt }>();
    s.seats.forEach((seat, i) => {
      const k = (i - meIndex + n) % n;
      const a = Math.PI / 2 + (k * 2 * Math.PI) / n;
      const at = (f: number, da = 0, fy = f): Pt => ({ x: cx + rx * f * Math.cos(a + da), y: cy + ry * fy * Math.sin(a + da) });
      // Seats pulled in a little top and bottom so cards above the top seat clear the header.
      map.set(seat.id, { seat: at(1, 0, 0.93), bet: at(0.62), button: at(0.76, 0.35) });
    });
    return map;
  }, [ids, meIndex, size.w, size.h]);
  const center: Pt = { x: size.w / 2, y: size.h / 2 };
  // Leave room for the side seats so their cards never cover the board.
  const boardW = Math.min(52, (size.w - 92) / 5.3);
  const cardH = boardW * 1.4;
  const twoBoards = s.split === 'double' || s.split === 'highlow';
  const boards = twoBoards
    ? [
        { cards: s.board, y: center.y - cardH / 2 - 8, label: s.split === 'highlow' ? 'HIGH' : 'BOARD 1' },
        { cards: s.board2, y: center.y + cardH / 2 + 8, label: s.split === 'highlow' ? 'LOW' : 'BOARD 2' },
      ]
    : [{ cards: s.board, y: center.y, label: '' }];
  const potPt: Pt = { x: size.w / 2, y: twoBoards ? center.y - cardH - 64 : center.y - size.w * 0.27 };
  const miniW = Math.min(26, size.w * 0.085);

  // ---- sounds and chip movement driven by state changes ----
  const prevRef = useRef<TableView | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = s;
    if (!prev) return;
    const sameHand = prev.handNo === s.handNo;
    const add: Ghost[] = [];
    let chips = !sameHand && s.phase === 'playing';
    if (!sameHand && s.phase === 'playing') sfx.deal(s.seats.filter(x => x.inHand).length * 2);
    if (sameHand && s.board.length > prev.board.length) sfx.flip(s.board.length - prev.board.length);
    for (const p of prev.seats) {
      const now = s.seats.find(x => x.id === p.id);
      if (!now || !sameHand) continue;
      if (now.bet > p.bet) chips = true;
      const g = geo.get(p.id);
      if (p.bet > 0 && now.bet === 0 && g) add.push({ key: `c${s.handNo}-${p.id}-${s.street}`, amount: p.bet, from: g.bet, to: potPt, delay: 0 });
    }
    if (chips) sfx.chip();
    if (s.winners.length && !(sameHand && prev.winners.length)) {
      const delay = add.length ? 0.6 : 0.25;
      for (const w of s.winners) {
        const g = geo.get(w.id);
        if (g) add.push({ key: `w${s.handNo}-${w.id}`, amount: w.amount, from: potPt, to: g.seat, delay });
      }
      setTimeout(() => sfx.win(), delay * 1000 + 250);
    }
    if (s.toAct === s.you && prev.toAct !== s.you) sfx.turn();
    if (add.length) {
      setGhosts(g => [...g, ...add]);
      const keys = new Set(add.map(a => a.key));
      setTimeout(() => setGhosts(g => g.filter(x => !keys.has(x.key))), 2000);
    }
  }, [s]);

  const me = s.seats.find(x => x.id === s.you);
  const dealer = s.seats.find(x => x.id === s.dealerId);
  const inHandOrder = s.seats.filter(x => x.inHand);
  const dealDelay = (seat: SeatView, i: number) => {
    const n = inHandOrder.length;
    const k = (inHandOrder.indexOf(seat) - inHandOrder.findIndex(x => x.id === s.dealerId) - 1 + n) % n;
    return (k + i * n) * 0.09;
  };
  const showWinners = s.phase === 'showdown' && s.winners.length > 0;
  const isWild = (c: Card | null) => s.wild && !!c && isAK47Wild(c);

  // Card picking for drop / arrange steps. Indexes into your hole cards.
  const [picked, setPicked] = useState<number[]>([]);
  const choosing = !!s.pending && !s.myReady && !!me && !me.folded;
  useEffect(() => setPicked([]), [s.pending?.kind, s.street, s.handNo, s.myReady]);
  const tapCard = (i: number) => {
    const p = s.pending;
    if (!choosing || !p) return;
    if (p.kind === 'drop') {
      setPicked(cur => cur.includes(i) ? cur.filter(x => x !== i) : cur.length < p.count ? [...cur, i] : [...cur.slice(1), i]);
    } else if (p.kind === 'drop_pair') {
      const a = i - (i % 2);
      setPicked(cur => cur[0] === a ? [] : [a, a + 1]);
    } else {
      // Arrange: first two taps make pair 1, next two pair 2, the rest is pair 3.
      setPicked(cur => {
        if (cur.includes(i)) return cur.slice(0, cur.indexOf(i));
        return cur.length < 4 ? [...cur, i] : cur;
      });
    }
  };
  const toastFn = (m: string) => setToast(m);

  return (
    <div className="screen">
      <header className="topbar">
        <button className="pill" onClick={() => shareTable(s.code, toastFn)}>⧉ {s.code}</button>
        <div className="title">
          <div>{gameName(s.game)}</div>
          <small>
            {s.target ? `${s.target.farthest ? 'Farthest from' : 'Closest to'} ${s.target.value} · ` : ''}
            Blinds {fmt(s.blinds.sb)}/{fmt(s.blinds.bb)}
          </small>
        </div>
        <button className="pill" onClick={() => { if (confirm('Leave the table?')) send({ t: 'leave' }); }}>Leave</button>
      </header>

      {!poker.connected && <div className="reconnecting">Reconnecting…</div>}

      <div className="table-wrap" ref={wrapRef}>
        <div className="table" style={{ width: size.w, height: size.h }}>
          <div className="felt-logo">POKER NIGHT</div>

          {boards.map((b, bi) => (
          <div key={bi} className="board" style={{ left: center.x, top: b.y }}>
            {b.label && <span className={`board-label ${b.label === 'LOW' ? 'low' : ''}`}>{b.label}</span>}
            {[0, 1, 2, 3, 4].map(i => b.cards[i]
              ? <CardView key={`${s.handNo}-${bi}-${i}`} card={b.cards[i]} width={boardW} className="flip-in" wild={isWild(b.cards[i])}
                  style={{ animationDelay: `${(i < 3 ? i * 0.15 : 0) + bi * 0.3}s` }} />
              : <div key={i} className="slot" style={{ width: boardW, height: cardH }} />)}
          </div>
          ))}

          {s.pot > 0 && (
            <ChipStack amount={s.pot} label="Pot" className={`pot ${showWinners ? 'paying' : ''}`}
              style={{ left: potPt.x, top: potPt.y }} />
          )}

          {s.seats.filter(x => x.bet > 0).map(seat => {
            const g = geo.get(seat.id)!;
            return (
              <ChipStack key={`${seat.id}-${seat.bet}`} amount={seat.bet} className="push-in"
                style={{ left: g.bet.x, top: g.bet.y, '--fx': `${g.seat.x - g.bet.x}px`, '--fy': `${g.seat.y - g.bet.y}px` }} />
            );
          })}

          {ghosts.map(g => (
            <ChipStack key={g.key} amount={g.amount} className="ghost"
              style={{
                left: g.from.x, top: g.from.y, animationDelay: `${g.delay}s`,
                '--tx': `${g.to.x - g.from.x}px`, '--ty': `${g.to.y - g.from.y}px`,
              }} />
          ))}

          {dealer && geo.get(dealer.id) && (
            <div className="dealer-btn" style={{ left: geo.get(dealer.id)!.button.x, top: geo.get(dealer.id)!.button.y }}>D</div>
          )}

          {s.seats.map(seat => {
            const g = geo.get(seat.id)!;
            const isMe = seat.id === s.you;
            const acting = s.toAct === seat.id;
            const cls = ['seat', acting && 'acting', seat.folded && 'folded', !seat.connected && 'away', seat.won && 'winner', isMe && 'me']
              .filter(Boolean).join(' ');
            return (
              <div key={seat.id} className={cls} style={{ left: g.seat.x, top: g.seat.y }}>
                {!isMe && seat.cards.length > 0 && (
                  <div className="mini-cards">
                    {seat.cards.map((c, i) => {
                      const w = c ? miniW * 1.35 : miniW;
                      const overlap = i > 0 && seat.cards.length > 2 ? -w * (seat.cards.length > 3 ? 0.6 : 0.35) : 0;
                      return (
                        <CardView key={`${s.handNo}-${i}`} card={c} width={w} className="deal-in" wild={isWild(c)}
                          style={{ marginLeft: overlap, '--fx': `${center.x - g.seat.x}px`, '--fy': `${center.y - g.seat.y}px`, animationDelay: `${dealDelay(seat, i)}s` }} />
                      );
                    })}
                  </div>
                )}
                <div className="avatar">{initials(seat.name)}</div>
                <div className="plate">
                  <div className="name">{isMe ? 'You' : seat.name}</div>
                  <div className="chips-amt">{seat.allIn && s.phase === 'playing' ? 'ALL IN' : fmt(seat.chips)}</div>
                </div>
                {acting && s.turnMsLeft != null && (
                  <div className="timer" key={`${s.handNo}-${s.street}-${s.currentBet}-${seat.id}`}>
                    <i style={{ '--from': s.turnMsLeft / s.turnMsTotal, animationDuration: `${s.turnMsLeft}ms` } as Vars} />
                  </div>
                )}
                {seat.handName && !isMe && !s.split && <div className="hand-name">{seat.handName}</div>}
                {!seat.connected && <div className="away-tag">away</div>}
                {seat.waiting && <div className="away-tag">choosing…</div>}
              </div>
            );
          })}

          {s.pending && (
            <div className="table-banner">{pendingTitle(s.pending.kind, s.pending.count, true)}</div>
          )}
          {s.phase === 'choosing' && s.dealerId !== s.you && (
            <div className="table-banner">{dealer?.name ?? 'Dealer'} is picking the game…</div>
          )}
          {showWinners && (
            <div className="table-banner win">
              {s.winners.map(w => {
                const who = w.id === s.you ? 'You win' : `${s.seats.find(x => x.id === w.id)?.name ?? '?'} wins`;
                return <div key={w.id}>{who} {fmt(w.amount)}{w.handName ? ` · ${w.handName}` : ''}</div>;
              })}
            </div>
          )}
        </div>
      </div>

      <div className="hand-area">
        {me && me.cards.length > 0
          ? s.split
            ? <SplitCards key={s.handNo} s={s} me={me} send={send} delay={dealDelay(me, 0)} />
            : <MyCards key={s.handNo} s={s} me={me} picked={picked} onTap={tapCard} delay={dealDelay(me, 0)} />
          : <div className="my-cards-empty" />}
        <div className="my-hand-name">
          {me?.folded ? 'Folded' : (s.myHandName ?? '').split(' · ').map(line => <div key={line}>{line}</div>)}
        </div>
      </div>

      {choosing && me
        ? <PendingControls s={s} me={me} picked={picked} setPicked={setPicked} send={send} />
        : <Actions s={s} me={me} send={send} />}

      {s.phase === 'lobby' && <WaitingRoom s={s} send={send} toast={toastFn} />}
      {s.phase === 'choosing' && s.dealerId === s.you && <GamePicker s={s} send={send} />}
      {shownToast && <div className="toast">{shownToast}</div>}
    </div>
  );
}

const PAIR_COLORS = ['#e8c45c', '#5cc8e8', '#e85c9a'];

function pendingTitle(kind: string, count: number, everyone = false): string {
  if (kind === 'arrange') return everyone ? 'Everyone is making their pairs' : 'Make your 3 pairs: tap 2 cards, then 2 more';
  if (kind === 'drop_pair') return everyone ? 'Everyone drops a pair' : 'Tap the pair you want to drop';
  return everyone ? `Everyone drops ${count} card${count > 1 ? 's' : ''}` : `Tap ${count === 1 ? 'the card' : `${count} cards`} you want to drop`;
}

function MyCards({ s, me, picked, onTap, delay }: {
  s: TableView; me: SeatView; picked: number[]; onTap: (i: number) => void; delay: number;
}) {
  const [peek, setPeek] = useState(false);
  const p = s.pending;
  const choosing = !!p && !s.myReady && !me.folded;
  const up = peek || choosing || !!me.handName;
  const n = me.cards.length;
  const width = Math.min(80, Math.floor((Math.min(window.innerWidth, 480) - 48) / (n * 0.92 + 0.2)));
  const arranging = choosing && p!.kind === 'arrange';
  const grouped = s.pairs && !arranging && n > 2; // show locked pairs with a gap between them
  const pairOf = (i: number): number | null => {
    if (arranging) {
      const k = picked.indexOf(i);
      if (k >= 0) return Math.floor(k / 2);
      return picked.length >= 4 ? 2 : null;
    }
    return grouped ? Math.floor(i / 2) : null;
  };
  const stop = () => setPeek(false);
  return (
    <div className={`my-cards ${me.folded ? 'folded' : ''} ${up ? 'up' : ''} ${choosing ? 'choosing' : ''}`}
      onPointerDown={e => {
        if (choosing) return;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ok */ }
        setPeek(true);
      }}
      onPointerUp={stop} onPointerCancel={stop} onContextMenu={e => e.preventDefault()}>
      {me.cards.map((c, i) => {
        const pair = pairOf(i);
        const isPicked = picked.includes(i) && !arranging;
        return (
          <div key={i} className={`my-card deal-up ${grouped && i % 2 === 1 && i < n - 1 ? 'pair-end' : ''}`}
            style={{ animationDelay: `${delay + i * 0.15}s` }}
            onClick={() => onTap(i)}>
            <div className={`tilt ${isPicked ? 'picked' : ''}`}
              style={{ '--rot': `${(i - (n - 1) / 2) * (n > 3 ? 4 : 7)}deg` } as Vars}>
              <FlipCard card={c} up={up} width={width} wild={s.wild && !!c && isAK47Wild(c)} />
              {pair != null && up && <span className="pair-tag" style={{ background: PAIR_COLORS[pair] }}>{pair + 1}</span>}
              {isPicked && <span className="drop-tag">DROP</span>}
            </div>
          </div>
        );
      })}
      {!up && !me.folded && <div className="peek-hint">Hold to peek</div>}
    </div>
  );
}

/**
 * Split games: your cards in two labeled hands. Tap "Swap cards", then a card in each hand
 * to trade them. You can keep changing until showdown.
 */
function SplitCards({ s, me, send, delay }: { s: TableView; me: SeatView; send: (m: ClientMsg) => void; delay: number }) {
  const [peek, setPeek] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const split = SPLITS[s.split!];
  const cards = me.cards as Card[];
  const n = cards.length;
  const canSwap = s.phase === 'playing' && !me.folded;
  const up = peek || swapping || !!me.handName;
  const width = Math.min(76, Math.floor((Math.min(window.innerWidth, 480) - 64) / (n * 0.95 + 0.2)));
  const groupOf = (i: number) => (i < split.sizes[0] ? 0 : 1);
  useEffect(() => { if (!canSwap) { setSwapping(false); setSel(null); } }, [canSwap]);

  const tap = (i: number) => {
    if (!swapping) return;
    if (sel == null || groupOf(sel) === groupOf(i)) { setSel(sel === i ? null : i); return; }
    const next = [...cards];
    [next[sel], next[i]] = [next[i], next[sel]];
    send({ t: 'arrange', cards: next });
    setSel(null);
  };
  const stop = () => setPeek(false);
  const groups = [[...Array(split.sizes[0]).keys()], [...Array(n - split.sizes[0]).keys()].map(k => k + split.sizes[0])];

  return (
    <div className={`split-hand ${me.folded ? 'folded' : ''}`}>
      <div className={`my-cards split ${up ? 'up' : ''}`}
        onPointerDown={e => {
          if (swapping) return;
          try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ok */ }
          setPeek(true);
        }}
        onPointerUp={stop} onPointerCancel={stop} onContextMenu={e => e.preventDefault()}>
        {groups.map((idxs, g) => (
          <div key={g} className="split-group">
            <div className="split-cards">
              {idxs.map(i => (
                <div key={i} className="my-card deal-up" style={{ animationDelay: `${delay + i * 0.12}s` }} onClick={() => tap(i)}>
                  <div className={`tilt ${sel === i ? 'picked' : ''}`}>
                    <FlipCard card={cards[i]} up={up} width={width} wild={false} />
                  </div>
                </div>
              ))}
            </div>
            <div className={`split-label ${s.split === 'highlow' && g === 1 ? 'low' : ''}`}>{split.labels[g]}</div>
          </div>
        ))}
        {!up && !me.folded && <div className="peek-hint">Hold to peek</div>}
      </div>
      {canSwap && (
        <button className={`pill swap-btn ${swapping ? 'on' : ''}`} onClick={() => { setSwapping(!swapping); setSel(null); }}>
          {swapping ? (sel == null ? 'Tap a card to move · Done' : 'Now tap a card in the other hand') : '⇄ Swap cards'}
        </button>
      )}
    </div>
  );
}

function PendingControls({ s, me, picked, setPicked, send }: {
  s: TableView; me: SeatView; picked: number[]; setPicked: (p: number[]) => void; send: (m: ClientMsg) => void;
}) {
  const p = s.pending!;
  const cards = me.cards as Card[];
  let ready = false;
  let label = '';
  let submit = () => {};
  if (p.kind === 'arrange') {
    ready = picked.length >= 4;
    label = 'Lock pairs';
    submit = () => send({ t: 'arrange', cards: [...picked, ...cards.map((_, i) => i).filter(i => !picked.includes(i))].map(i => cards[i]) });
  } else {
    const need = p.kind === 'drop_pair' ? 2 : p.count;
    ready = picked.length === need;
    label = p.kind === 'drop_pair' ? 'Drop pair' : `Drop ${need === 1 ? 'card' : `${need} cards`}`;
    submit = () => send({ t: 'discard', cards: picked.map(i => cards[i]) });
  }
  return (
    <div className="actions">
      <div className="status">{pendingTitle(p.kind, p.count)}</div>
      {s.turnMsLeft != null && (
        <div className="timer wide" key={`${s.handNo}-${s.street}-${p.kind}`}>
          <i style={{ '--from': s.turnMsLeft / s.turnMsTotal, animationDuration: `${s.turnMsLeft}ms` } as Vars} />
        </div>
      )}
      <div className="row">
        {p.kind === 'arrange' && <button className="btn" onClick={() => setPicked([])}>Reset</button>}
        <button className="btn primary" disabled={!ready} onClick={submit}>{label}</button>
      </div>
    </div>
  );
}

function Actions({ s, me, send }: { s: TableView; me?: SeatView; send: (m: ClientMsg) => void }) {
  const myTurn = s.phase === 'playing' && s.toAct === s.you && !!me;
  const [raising, setRaising] = useState(false);
  const [amount, setAmount] = useState(s.minRaiseTo);
  useEffect(() => { setRaising(false); setAmount(s.minRaiseTo); }, [s.toAct, s.street, s.handNo, s.currentBet]);

  if (me && me.chips === 0 && !(s.phase === 'playing' && me.inHand && !me.folded)) {
    return (
      <div className="actions">
        <button className="btn primary" onClick={() => send({ t: 'rebuy' })}>Rebuy {fmt(s.startingChips)}</button>
      </div>
    );
  }

  if (!myTurn || !me) {
    const acting = s.seats.find(x => x.id === s.toAct);
    let text = '';
    if (s.phase === 'playing' && acting) text = `Waiting for ${acting.name}…`;
    if (s.pending) text = `Waiting for ${s.seats.filter(x => x.waiting).map(x => x.name).join(', ') || 'others'}…`;
    if (s.phase === 'choosing') text = 'New hand coming up';
    return <div className="actions"><div className="status">{text || s.log[s.log.length - 1] || ''}</div></div>;
  }

  const bets = s.seats.reduce((t, x) => t + x.bet, 0);
  const potTotal = s.pot + bets;
  const clamp = (v: number) => Math.max(s.minRaiseTo, Math.min(s.maxRaiseTo, Math.round(v)));
  const canRaise = s.maxRaiseTo > s.currentBet && s.maxRaiseTo > me.bet + s.callAmount;
  const verb = s.currentBet === 0 ? 'Bet' : 'Raise';
  const allInAmount = amount >= s.maxRaiseTo;
  const doRaise = () => send({ t: 'act', action: allInAmount ? 'allin' : 'raise', amount });

  if (raising) {
    const quick: [string, number][] = [
      ['Min', s.minRaiseTo],
      ['½ Pot', clamp(s.currentBet + (potTotal + s.callAmount) / 2)],
      ['Pot', clamp(s.currentBet + potTotal + s.callAmount)],
      ['All in', s.maxRaiseTo],
    ];
    return (
      <div className="actions raise-panel">
        <div className="row quick">
          {quick.map(([label, v]) => (
            <button key={label} className={`chip-btn ${amount === v ? 'on' : ''}`} onClick={() => setAmount(v)}>{label}</button>
          ))}
        </div>
        <input type="range" min={s.minRaiseTo} max={s.maxRaiseTo} step={s.blinds.sb}
          value={amount} onChange={e => setAmount(clamp(Number(e.target.value)))} />
        <div className="row">
          <button className="btn" onClick={() => setRaising(false)}>Back</button>
          <PushChips amount={amount} label={allInAmount ? 'All in' : `${verb} to`} onPush={doRaise} />
        </div>
      </div>
    );
  }

  return (
    <div className="actions">
      <div className="row">
        <button className="btn fold" onClick={() => send({ t: 'act', action: 'fold' })}>Fold</button>
        {s.callAmount === 0
          ? <button className="btn call" onClick={() => send({ t: 'act', action: 'check' })}>Check</button>
          : <button className="btn call" onClick={() => send({ t: 'act', action: 'call' })}>
              {s.callAmount >= me.chips ? 'All in' : 'Call'} {fmt(s.callAmount)}
            </button>}
        {canRaise && <button className="btn raise" onClick={() => setRaising(true)}>{verb}</button>}
      </div>
    </div>
  );
}

/** Drag the chip stack up toward the table to bet, like pushing chips in. Tapping the button also works. */
function PushChips({ amount, label, onPush }: { amount: number; label: string; onPush: () => void }) {
  const [dy, setDy] = useState(0);
  const start = useRef<number | null>(null);
  const armed = dy < -SWIPE;
  const reset = () => { start.current = null; setDy(0); };
  return (
    <div className="push"
      onPointerDown={e => { start.current = e.clientY; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ok */ } }}
      onPointerMove={e => { if (start.current != null) setDy(Math.max(-140, Math.min(0, e.clientY - start.current))); }}
      onPointerUp={() => { if (start.current != null && (armed || dy > -6)) onPush(); reset(); }}
      onPointerCancel={reset}>
      <div className={`push-chips ${armed ? 'armed' : ''}`} style={{ transform: `translateY(${dy}px)` }}>
        <ChipStack amount={amount} className="static" />
      </div>
      <div className="push-label">{armed ? 'Release to push' : `${label} ${fmt(amount)}`}</div>
    </div>
  );
}

function WaitingRoom({ s, send, toast }: { s: TableView; send: (m: ClientMsg) => void; toast: (m: string) => void }) {
  const isHost = s.hostId === s.you;
  const ready = s.seats.filter(x => x.chips > 0).length >= 2;
  return (
    <div className="sheet">
      <div className="sheet-title">Table {s.code}</div>
      <p className="muted">Send this code to your friends. Starting chips {fmt(s.startingChips)}, blinds {fmt(s.blinds.sb)}/{fmt(s.blinds.bb)}.</p>
      <button className="btn" onClick={() => shareTable(s.code, toast)}>Share invite</button>
      <ul className="players">
        {s.seats.map(x => (
          <li key={x.id}>
            <span className="avatar sm">{initials(x.name)}</span>
            {x.id === s.you ? `${x.name} (you)` : x.name}
            {x.id === s.hostId && <em>host</em>}
            {!x.connected && <em>away</em>}
          </li>
        ))}
      </ul>
      {isHost
        ? <button className="btn primary" disabled={!ready} onClick={() => send({ t: 'start' })}>
            {ready ? 'Start game' : 'Waiting for players…'}
          </button>
        : <p className="muted center">Waiting for the host to start…</p>}
    </div>
  );
}

function GamePicker({ s, send }: { s: TableView; send: (m: ClientMsg) => void }) {
  const [custom, setCustom] = useState(false);
  const [target, setTarget] = useState('500');
  const [farthest, setFarthest] = useState(false);
  const value = Number(target);
  const valid = target.trim() !== '' && Number.isInteger(value) && value >= 0 && value <= 999;

  if (custom) {
    return (
      <div className="sheet">
        <div className="sheet-title">Triple 9 Custom</div>
        <p className="muted">Pick the number everyone plays for (0 to 999).</p>
        <input className="target-input" inputMode="numeric" maxLength={3} value={target}
          onChange={e => setTarget(e.target.value.replace(/\D/g, ''))} />
        <div className="row">
          <button className={`chip-btn ${!farthest ? 'on' : ''}`} onClick={() => setFarthest(false)}>Closest wins</button>
          <button className={`chip-btn ${farthest ? 'on' : ''}`} onClick={() => setFarthest(true)}>Farthest wins</button>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setCustom(false)}>Back</button>
          <button className="btn primary" disabled={!valid}
            onClick={() => send({ t: 'choose', game: 'triple9_custom', target: value, farthest })}>Deal</button>
        </div>
      </div>
    );
  }

  return (
    <div className="sheet">
      <div className="sheet-title">You're dealing, pick the game</div>
      <div className="games">
        {GAMES.map(g => (
          <button key={g.id} className={`game ${g.ready ? '' : 'soon'}`} disabled={!g.ready}
            onClick={() => (g.id === 'triple9_custom' ? setCustom(true) : send({ t: 'choose', game: g.id }))}>
            <strong>{g.name}</strong>
            <span>{g.ready ? g.blurb : 'Coming soon'}</span>
          </button>
        ))}
      </div>
      {s.turnMsLeft != null && <p className="muted center">Hold'em starts automatically if you don't pick.</p>}
    </div>
  );
}
