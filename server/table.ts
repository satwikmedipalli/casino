import { randomUUID } from 'node:crypto';
import { GAMES, SPLITS, fmt, isAK47Wild } from '../shared/types';
import type { Action, Card, GameId, Pending, Phase, SeatView, SplitKind, Street, TableView, Target } from '../shared/types';
import { newDeck, rankValue } from './cards';
import { bestHand, bestUsing, bestWild, combinations, triple9Number, worstHand } from './evaluate';
import type { HandScore } from './evaluate';

const TURN_MS = 40_000;
const AWAY_TURN_MS = 10_000;
const CHOOSE_MS = 45_000;
const RUNOUT_MS = 1_500;
const SHOWDOWN_MS = 8_000;
const FOLD_WIN_MS = 3_500;
const MAX_PLAYERS = 9;
const PENDING_MS = 30_000;

/** How each game differs from Hold'em. Drops happen as each street opens, before its betting. */
interface Rules {
  hole: number;
  drops?: Partial<Record<Street, number>>;
  pairs?: boolean;  // arrange into locked pairs before the flop; drops remove whole pairs
  use?: number;     // showdown uses exactly this many hole cards
  wild?: boolean;
  split?: SplitKind;
}
const RULES: Record<GameId, Rules> = {
  holdem: { hole: 2 },
  irish: { hole: 3, drops: { preflop: 1 } },
  three_card: { hole: 3, use: 2 },
  ak47: { hole: 2, wild: true },
  omaha5: { hole: 5, drops: { preflop: 1, flop: 1, turn: 1 } },
  omaha6: { hole: 6, pairs: true, drops: { flop: 2, turn: 2 } },
  triple9: { hole: 5, split: 'triple9' },
  triple9_custom: { hole: 5, split: 'triple9' },
  double_board: { hole: 4, split: 'double' },
  high_low: { hole: 4, split: 'highlow' },
};

export class GameError extends Error {}

interface Player {
  id: string;
  token: string;
  name: string;
  seat: number;
  chips: number;
  connected: boolean;
  leaving: boolean;
}

interface HandPlayer {
  id: string;
  hole: Card[];
  folded: boolean;
  allIn: boolean;
  bet: number;   // this street
  total: number; // whole hand, used for side pots
  acted: boolean;
  ready: boolean; // done with the current drop / arrange step
  score?: number;
  scores?: number[]; // split games: one score per half
  names?: string[];
  liveKey?: string;
  liveName?: string;
  handName?: string;
  won: number;
}

interface Hand {
  game: GameId;
  deck: Card[];
  board: Card[];
  board2: Card[];
  target: Target | null;
  order: string[]; // participant ids in seat order
  hp: Map<string, HandPlayer>;
  street: Street;
  toAct: string | null;
  currentBet: number;
  minRaise: number;
  sbId: string;
  bbId: string;
  revealed: boolean;
  pending: Pending | null;
  winners: { id: string; amount: number; handName?: string }[];
}

export class Room {
  players: Player[] = [];
  hostId = '';
  phase: Phase = 'lobby';
  dealerId: string | null = null;
  private dealerSeat = -1;
  hand: Hand | null = null;
  handNo = 0;
  log: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private turnDeadline: number | null = null;
  private turnTotal = TURN_MS;

  constructor(
    public code: string,
    public startingChips: number,
    public bb: number,
    private onChange: () => void,
  ) {}

  get sb() { return Math.max(1, Math.floor(this.bb / 2)); }

  dispose() { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  // ---------- seating ----------

  addPlayer(name: string): Player {
    if (this.players.length >= MAX_PLAYERS) throw new GameError('Table is full');
    const used = new Set(this.players.map(p => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    const p: Player = {
      id: randomUUID(), token: randomUUID(), name: name.trim().slice(0, 14) || 'Player',
      seat, chips: this.startingChips, connected: true, leaving: false,
    };
    this.players.push(p);
    this.players.sort((a, b) => a.seat - b.seat);
    if (!this.hostId) this.hostId = p.id;
    this.say(`${p.name} sat down`);
    return p;
  }

  byToken(token: string) { return this.players.find(p => p.token === token); }
  player(id: string) { return this.players.find(p => p.id === id); }

  setConnected(id: string, connected: boolean) {
    const p = this.player(id);
    if (!p) return;
    p.connected = connected;
    // Don't make everyone wait 40s on someone whose phone went to sleep.
    if (!connected && this.hand?.toAct === id) this.setTurn(id);
  }

  leave(id: string) {
    const p = this.player(id);
    if (!p) return;
    const h = this.hand;
    const x = h?.hp.get(id);
    if (h && x && (this.phase === 'playing' || this.phase === 'showdown')) {
      p.leaving = true;
      if (this.phase === 'playing' && !x.folded) {
        if (h.toAct === id) this.act(id, 'fold');
        else {
          x.folded = true;
          this.say(`${p.name} folds`);
          const live = this.live();
          if (live.length === 1) this.winByFold(live[0]);
          else if (h.pending && live.every(l => l.ready)) this.finishPending();
        }
      }
    } else {
      this.players = this.players.filter(q => q.id !== id);
      if (this.phase === 'choosing' && this.dealerId === id) this.nextHand();
    }
    this.say(`${p.name} left`);
    if (this.hostId === id) this.hostId = this.players.find(q => !q.leaving)?.id ?? '';
  }

  rebuy(id: string) {
    const p = this.player(id);
    if (!p) return;
    const x = this.hand?.hp.get(id);
    if (this.phase === 'playing' && x && !x.folded) throw new GameError('Finish this hand first');
    if (p.chips > 0) throw new GameError('You still have chips');
    p.chips = this.startingChips;
    this.say(`${p.name} rebought for ${fmt(this.startingChips)}`);
  }

  // ---------- flow ----------

  start(by: string) {
    if (by !== this.hostId) throw new GameError('Only the host can start');
    if (this.phase !== 'lobby') throw new GameError('Already started');
    const eligible = this.players.filter(p => p.chips > 0 && !p.leaving);
    if (eligible.length < 2) throw new GameError('Need at least 2 players');
    const first = eligible[Math.floor(Math.random() * eligible.length)];
    this.dealerSeat = first.seat;
    this.beginChoosing(first);
  }

  choose(by: string, game: GameId, target?: number, farthest?: boolean) {
    if (this.phase !== 'choosing') throw new GameError('Not choosing right now');
    if (by !== this.dealerId) throw new GameError('Only the dealer picks the game');
    const info = GAMES.find(g => g.id === game);
    if (!info?.ready) throw new GameError('That game is coming soon');
    let t: Target | null = null;
    if (game === 'triple9') t = { value: 999, farthest: false };
    if (game === 'triple9_custom') {
      const value = Number(target);
      if (!Number.isInteger(value) || value < 0 || value > 999) throw new GameError('Pick a number from 0 to 999');
      t = { value, farthest: !!farthest };
    }
    this.startHand(game, t);
  }

  private beginChoosing(dealer: Player) {
    this.hand = null;
    this.dealerId = dealer.id;
    this.dealerSeat = dealer.seat;
    this.phase = 'choosing';
    this.turnDeadline = Date.now() + CHOOSE_MS;
    this.turnTotal = CHOOSE_MS;
    this.say(`${dealer.name} is dealing`);
    this.schedule(CHOOSE_MS, () => { if (this.phase === 'choosing') this.startHand('holdem'); });
  }

  private nextHand() {
    this.players = this.players.filter(p => !p.leaving);
    if (!this.player(this.hostId)) this.hostId = this.players[0]?.id ?? '';
    this.hand = null;
    const eligible = this.players.filter(p => p.chips > 0);
    if (eligible.length < 2) {
      this.phase = 'lobby';
      this.dealerId = null;
      this.turnDeadline = null;
      this.say('Waiting for more players with chips');
      return;
    }
    const next = eligible.find(p => p.seat > this.dealerSeat) ?? eligible[0];
    this.beginChoosing(next);
  }

  private startHand(game: GameId, target: Target | null = null) {
    const parts = this.players.filter(p => p.chips > 0 && !p.leaving);
    if (parts.length < 2) { this.nextHand(); return; }
    if (!parts.some(p => p.id === this.dealerId)) this.dealerId = parts[0].id;
    const dealerId = this.dealerId!;
    this.handNo++;
    const order = parts.map(p => p.id);
    const hp = new Map<string, HandPlayer>(order.map(id => [id, {
      id, hole: [], folded: false, allIn: false, bet: 0, total: 0, acted: false, ready: true, won: 0,
    }]));
    const next = (id: string) => order[(order.indexOf(id) + 1) % order.length];
    const sbId = order.length === 2 ? dealerId : next(dealerId);
    const bbId = next(sbId);
    const deck = newDeck();
    this.hand = {
      game, deck, board: [], board2: [], target, order, hp, street: 'preflop', toAct: null,
      currentBet: this.bb, minRaise: this.bb, sbId, bbId, revealed: false, pending: null, winners: [],
    };
    this.phase = 'playing';
    this.post(sbId, this.sb);
    this.post(bbId, this.bb);
    for (let round = 0; round < RULES[game].hole; round++) {
      let id = next(dealerId);
      for (let i = 0; i < order.length; i++) { hp.get(id)!.hole.push(deck.pop()!); id = next(id); }
    }
    if (RULES[game].split) for (const x of hp.values()) this.defaultSplit(x);
    const name = GAMES.find(g => g.id === game)!.name;
    const goal = target ? ` (${target.farthest ? 'farthest from' : 'closest to'} ${target.value})` : '';
    this.say(`Hand #${this.handNo}: ${name}${goal}, blinds ${fmt(this.sb)}/${fmt(this.bb)}`);
    this.beginStreet();
  }

  /** Drop cards during a drop step. */
  discard(id: string, cards: Card[]) {
    const { h, x } = this.pendingFor(id);
    const p = h.pending!;
    if (p.kind === 'arrange') throw new GameError('Arrange your pairs first');
    const picked = [...new Set(cards)];
    if (picked.length !== p.count || !picked.every(c => x.hole.includes(c))) throw new GameError(`Pick ${p.count} of your cards`);
    if (p.kind === 'drop_pair') {
      const i = x.hole.indexOf(picked[0]);
      const pair = x.hole.slice(i - (i % 2), i - (i % 2) + 2);
      if (!pair.includes(picked[1])) throw new GameError('Pick one of your pairs');
    }
    x.hole = x.hole.filter(c => !picked.includes(c));
    this.markReady(x);
  }

  /**
   * Set the order of your cards. In 6 Card Omaha consecutive cards become locked pairs.
   * In split games the first cards are your first hand, and you can change it until showdown.
   */
  arrange(id: string, cards: Card[]) {
    const sh = this.hand;
    if (sh && RULES[sh.game].split) {
      const sx = sh.hp.get(id);
      if (this.phase !== 'playing' || !sx || sx.folded) throw new GameError('Too late to change');
      if (cards.length !== sx.hole.length || new Set(cards).size !== cards.length || !cards.every(c => sx.hole.includes(c))) {
        throw new GameError('Use each of your cards once');
      }
      sx.hole = [...cards];
      return;
    }
    const { h, x } = this.pendingFor(id);
    if (h.pending!.kind !== 'arrange') throw new GameError('Nothing to arrange right now');
    if (cards.length !== x.hole.length || [...new Set(cards)].length !== cards.length || !cards.every(c => x.hole.includes(c))) {
      throw new GameError('Use each of your cards once');
    }
    x.hole = [...cards];
    this.markReady(x);
  }

  private pendingFor(id: string) {
    const h = this.hand;
    const x = h?.hp.get(id);
    if (!h || !h.pending || this.phase !== 'playing' || !x || x.folded) throw new GameError('Nothing to do right now');
    if (x.ready) throw new GameError('Already done, waiting for others');
    return { h, x };
  }

  private markReady(x: HandPlayer) {
    x.ready = true;
    if (this.live().every(l => l.ready)) this.finishPending();
  }

  act(id: string, action: Action, amount?: number) {
    const h = this.hand;
    if (!h || this.phase !== 'playing' || h.toAct !== id) throw new GameError("It's not your turn");
    const x = h.hp.get(id)!;
    const p = this.player(id)!;
    const toCall = h.currentBet - x.bet;
    const maxTo = x.bet + p.chips;

    switch (action) {
      case 'fold':
        x.folded = true;
        this.say(`${p.name} folds`);
        break;
      case 'check':
        if (toCall > 0) throw new GameError('You need to call or fold');
        this.say(`${p.name} checks`);
        break;
      case 'call':
        if (toCall <= 0) { this.say(`${p.name} checks`); break; }
        this.post(id, Math.min(toCall, p.chips));
        this.say(`${p.name} calls ${fmt(x.bet)}${x.allIn ? ' (all in)' : ''}`);
        break;
      case 'raise':
      case 'allin': {
        let to = action === 'allin' ? maxTo : Math.floor(Number(amount));
        if (!Number.isFinite(to)) throw new GameError('Bad amount');
        to = Math.min(to, maxTo);
        const minTo = h.currentBet + h.minRaise;
        if (to <= h.currentBet) {
          // All in for no more than a call.
          if (to < maxTo) throw new GameError(`Minimum is ${fmt(minTo)}`);
          this.post(id, p.chips);
          this.say(`${p.name} calls ${fmt(x.bet)} (all in)`);
          break;
        }
        if (to < minTo && to < maxTo) throw new GameError(`Minimum is ${fmt(minTo)}`);
        const wasBet = h.currentBet;
        const inc = to - h.currentBet;
        if (inc >= h.minRaise) h.minRaise = inc;
        h.currentBet = to;
        this.post(id, to - x.bet);
        for (const o of h.hp.values()) if (o.id !== id) o.acted = false;
        const verb = wasBet === 0 ? 'bets' : 'raises to';
        this.say(`${p.name} ${verb} ${fmt(to)}${x.allIn ? ' (all in)' : ''}`);
        break;
      }
      default:
        throw new GameError('Unknown action');
    }
    x.acted = true;
    this.proceed(id);
  }

  // ---------- internals ----------

  private say(msg: string) {
    this.log.push(msg);
    if (this.log.length > 40) this.log.shift();
  }

  private schedule(ms: number, fn: () => void) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try { fn(); } catch (e) { console.error(e); }
      this.onChange();
    }, ms);
    this.timer.unref(); // the HTTP server keeps the process alive, not table timers
  }

  private post(id: string, amount: number) {
    const x = this.hand!.hp.get(id)!;
    const p = this.player(id)!;
    const a = Math.min(amount, p.chips);
    p.chips -= a;
    x.bet += a;
    x.total += a;
    if (p.chips === 0) x.allIn = true;
  }

  private live() { return [...this.hand!.hp.values()].filter(x => !x.folded); }

  private roundDone(): boolean {
    const h = this.hand!;
    const actors = this.live().filter(x => !x.allIn);
    if (actors.length === 0) return true;
    if (actors.length === 1 && actors[0].bet >= h.currentBet) return true;
    return actors.every(x => x.acted && x.bet === h.currentBet);
  }

  private nextActor(fromId: string): string | null {
    const h = this.hand!;
    const i = h.order.indexOf(fromId);
    for (let k = 1; k <= h.order.length; k++) {
      const x = h.hp.get(h.order[(i + k) % h.order.length])!;
      if (!x.folded && !x.allIn && !(x.acted && x.bet === h.currentBet)) return x.id;
    }
    return null;
  }

  /** A street just opened: run its drop / arrange step if the game has one, then betting. */
  private beginStreet() {
    const h = this.hand!;
    const rules = RULES[h.game];
    let pending: Pending | null = null;
    if (rules.pairs && h.street === 'preflop') pending = { kind: 'arrange', count: 0 };
    const n = rules.drops?.[h.street];
    if (n) pending = { kind: rules.pairs ? 'drop_pair' : 'drop', count: n };
    if (!pending) return this.startBetting();

    h.pending = pending;
    h.toAct = null;
    for (const x of h.hp.values()) x.ready = x.folded;
    this.turnDeadline = Date.now() + PENDING_MS;
    this.turnTotal = PENDING_MS;
    const handNo = this.handNo;
    const street = h.street;
    this.schedule(PENDING_MS, () => {
      if (this.handNo !== handNo || this.hand?.street !== street || !this.hand.pending) return;
      for (const x of this.live()) if (!x.ready) this.autoPending(x);
      this.finishPending();
    });
  }

  /** Time ran out: drop the lowest cards (or lowest pair), keep the order for arranging. */
  private autoPending(x: HandPlayer) {
    const p = this.hand!.pending!;
    if (p.kind === 'drop') {
      const lowest = [...x.hole].sort((a, b) => rankValue(a) - rankValue(b)).slice(0, p.count);
      x.hole = x.hole.filter(c => !lowest.includes(c));
    } else if (p.kind === 'drop_pair') {
      let worst = 0;
      const sum = (i: number) => rankValue(x.hole[i]) + rankValue(x.hole[i + 1]);
      for (let i = 2; i < x.hole.length; i += 2) if (sum(i) < sum(worst)) worst = i;
      x.hole.splice(worst, 2);
    }
    x.ready = true;
  }

  private finishPending() {
    const h = this.hand!;
    const kind = h.pending?.kind;
    h.pending = null;
    this.turnDeadline = null;
    this.say(kind === 'arrange' ? 'Pairs locked' : 'Cards dropped');
    this.startBetting();
  }

  private startBetting() {
    const h = this.hand!;
    if (h.street === 'preflop') return this.proceed(h.bbId);
    if (this.live().filter(x => !x.allIn).length <= 1) {
      // Everyone's all in: table the cards and run out the board slowly for drama.
      h.revealed = true;
      this.schedule(RUNOUT_MS, () => this.endStreet());
      return;
    }
    const first = this.nextActor(this.dealerId!);
    if (first) this.setTurn(first);
    else this.endStreet();
  }

  /** A sensible starting split; players can rearrange it any time before showdown. */
  private defaultSplit(x: HandPlayer) {
    const h = this.hand!;
    const kind = RULES[h.game].split!;
    if (kind === 'triple9') {
      let best = x.hole.slice(0, 3);
      let bestScore = -Infinity;
      for (const three of combinations(x.hole, 3)) {
        const s = triple9Number(three, h.target!.value, h.target!.farthest).score;
        if (s > bestScore) { bestScore = s; best = three; }
      }
      x.hole = [...best, ...x.hole.filter(c => !best.includes(c))];
    } else if (kind === 'highlow') {
      x.hole.sort((a, b) => rankValue(b) - rankValue(a)); // big cards to High, small to Low
    }
  }

  /** Split games: the two halves of a player's hand, each with a score and a short name. */
  private halves(x: HandPlayer): { score: number; name: string }[] {
    const h = this.hand!;
    const kind = RULES[h.game].split!;
    const n = SPLITS[kind].sizes[0];
    const a = x.hole.slice(0, n);
    const b = x.hole.slice(n);
    const open = h.board.length >= 3;
    const none = { score: 0, name: '' };
    if (kind === 'triple9') {
      const num = triple9Number(a, h.target!.value, h.target!.farthest);
      return [{ score: num.score, name: num.text }, open ? bestHand([...b, ...h.board]) : none];
    }
    if (!open) return [none, none];
    const low = kind === 'highlow';
    return [bestHand([...a, ...h.board]), low ? worstHand([...b, ...h.board2]) : bestHand([...b, ...h.board2])];
  }

  private liveName(x: HandPlayer): string {
    const kind = RULES[this.hand!.game].split;
    if (!kind) return this.evaluate(x).name;
    return this.halves(x).map((s, i) => (s.name ? `${SPLITS[kind].labels[i]}: ${s.name}` : '')).filter(Boolean).join(' · ');
  }

  private evaluate(x: HandPlayer): HandScore {
    const h = this.hand!;
    const rules = RULES[h.game];
    if (rules.wild) return bestWild([...x.hole, ...h.board], isAK47Wild);
    if (rules.use) return bestUsing(x.hole, h.board, rules.use);
    return bestHand([...x.hole, ...h.board]);
  }

  private proceed(fromId: string) {
    const live = this.live();
    if (live.length === 1) return this.winByFold(live[0]);
    if (this.roundDone()) return this.endStreet();
    const next = this.nextActor(fromId);
    if (next) this.setTurn(next);
    else this.endStreet();
  }

  private setTurn(id: string) {
    const h = this.hand!;
    h.toAct = id;
    const ms = this.player(id)?.connected ? TURN_MS : AWAY_TURN_MS;
    this.turnDeadline = Date.now() + ms;
    this.turnTotal = ms;
    const handNo = this.handNo;
    this.schedule(ms, () => {
      if (this.handNo !== handNo || this.hand?.toAct !== id || this.phase !== 'playing') return;
      const x = this.hand.hp.get(id)!;
      this.act(id, x.bet >= this.hand.currentBet ? 'check' : 'fold');
    });
  }

  private endStreet() {
    const h = this.hand!;
    for (const x of h.hp.values()) { x.bet = 0; x.acted = false; }
    h.currentBet = 0;
    h.minRaise = this.bb;
    h.toAct = null;
    this.turnDeadline = null;
    if (h.street === 'river') return this.showdown();
    h.deck.pop(); // burn
    const two = RULES[h.game].split === 'double' || RULES[h.game].split === 'highlow';
    const deal = (n: number) => {
      for (let i = 0; i < n; i++) h.board.push(h.deck.pop()!);
      if (two) { h.deck.pop(); for (let i = 0; i < n; i++) h.board2.push(h.deck.pop()!); }
    };
    if (h.street === 'preflop') { deal(3); h.street = 'flop'; }
    else if (h.street === 'flop') { deal(1); h.street = 'turn'; }
    else { deal(1); h.street = 'river'; }
    this.beginStreet();
  }

  private orderFromDealer(ids: string[]): string[] {
    const h = this.hand!;
    const start = h.order.indexOf(this.dealerId!);
    const rank = (id: string) => (h.order.indexOf(id) - start - 1 + h.order.length) % h.order.length;
    return [...ids].sort((a, b) => rank(a) - rank(b));
  }

  private showdown() {
    const h = this.hand!;
    h.street = 'showdown';
    h.revealed = true;
    h.toAct = null;
    this.phase = 'showdown';
    const live = this.live();
    const kind = RULES[h.game].split;
    for (const x of live) {
      if (kind) {
        const hs = this.halves(x);
        x.scores = hs.map(s => s.score);
        x.names = hs.map((s, i) => `${SPLITS[kind].labels[i]}: ${s.name}`);
        x.handName = x.names.join(' · ');
      } else {
        const best = this.evaluate(x);
        x.score = best.score;
        x.handName = best.name;
      }
    }

    const all = [...h.hp.values()];
    const levels = [...new Set(all.map(x => x.total).filter(t => t > 0))].sort((a, b) => a - b);
    const winnings = new Map<string, number>();
    const why = new Map<string, Set<string>>();
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const x of all) amount += Math.min(x.total, level) - Math.min(x.total, prev);
      prev = level;
      let eligible = live.filter(x => x.total >= level);
      if (eligible.length === 0) eligible = live;
      if (amount === 0) continue;
      // Split games pay half to each hand; the odd cent goes to the first half.
      const shares = kind ? [Math.ceil(amount / 2), Math.floor(amount / 2)] : [amount];
      shares.forEach((share, part) => {
        if (share === 0) return;
        const score = (x: HandPlayer) => (kind ? x.scores![part] : x.score!);
        const top = Math.max(...eligible.map(score));
        const winners = this.orderFromDealer(eligible.filter(x => score(x) === top).map(x => x.id));
        const each = Math.floor(share / winners.length);
        let rem = share - each * winners.length;
        for (const id of winners) {
          const add = each + (rem > 0 ? 1 : 0);
          if (rem > 0) rem--;
          winnings.set(id, (winnings.get(id) ?? 0) + add);
          const x = h.hp.get(id)!;
          if (!why.has(id)) why.set(id, new Set());
          why.get(id)!.add(kind ? x.names![part] : x.handName!);
        }
      });
    }
    for (const [id, amount] of winnings) {
      this.player(id)!.chips += amount;
      const x = h.hp.get(id)!;
      x.won = amount;
      const reason = [...why.get(id)!].join(' + ');
      h.winners.push({ id, amount, handName: reason });
      this.say(`${this.player(id)!.name} wins ${fmt(amount)} with ${reason}`);
    }
    this.schedule(SHOWDOWN_MS, () => this.nextHand());
  }

  private winByFold(w: HandPlayer) {
    const h = this.hand!;
    let total = 0;
    for (const x of h.hp.values()) { total += x.total; x.bet = 0; }
    this.player(w.id)!.chips += total;
    w.won = total;
    h.winners = [{ id: w.id, amount: total }];
    h.street = 'showdown';
    h.toAct = null;
    this.turnDeadline = null;
    this.phase = 'showdown';
    this.say(`${this.player(w.id)!.name} wins ${fmt(total)}`);
    this.schedule(FOLD_WIN_MS, () => this.nextHand());
  }

  // ---------- what each player is allowed to see ----------

  view(forId: string): TableView {
    const h = this.hand;
    const me = h?.hp.get(forId);
    const myChips = this.player(forId)?.chips ?? 0;
    const seats: SeatView[] = this.players.map(p => {
      const x = h?.hp.get(p.id);
      let cards: (Card | null)[] = [];
      if (x && (!x.folded || p.id === forId)) {
        const show = p.id === forId || (h!.revealed && !x.folded);
        cards = x.hole.map(c => (show ? c : null));
      }
      return {
        id: p.id, name: p.name, chips: p.chips, connected: p.connected,
        inHand: !!x, folded: !!x?.folded, allIn: !!x?.allIn, bet: x?.bet ?? 0, cards,
        handName: h?.revealed && x && !x.folded ? x.handName : undefined,
        won: x?.won || undefined,
        waiting: !!(h?.pending && x && !x.folded && !x.ready),
      };
    });
    let pot = 0;
    if (h) for (const x of h.hp.values()) pot += x.total - x.bet;
    const currentBet = h?.currentBet ?? 0;
    const callAmount = me ? Math.min(Math.max(0, currentBet - me.bet), myChips) : 0;
    const maxRaiseTo = me ? me.bet + myChips : 0;
    let myHandName: string | null = null;
    // In drop games the name is only meaningful once you're down to the cards you'll play.
    const settled = !(RULES[h?.game ?? 'holdem'].drops) || (me?.hole.length ?? 0) <= 2;
    const split = h ? RULES[h.game].split : undefined;
    if (h && me && !me.folded && (h.board.length >= 3 || split === 'triple9') && settled) {
      const key = `${me.hole.join()}|${h.board.length}`;
      if (me.liveKey !== key) { me.liveKey = key; me.liveName = this.liveName(me); }
      myHandName = me.handName ?? me.liveName!;
    }

    return {
      code: this.code,
      you: forId,
      hostId: this.hostId,
      phase: this.phase,
      game: h?.game ?? null,
      handNo: this.handNo,
      street: h?.street ?? null,
      dealerId: this.dealerId,
      sbId: h?.sbId ?? null,
      bbId: h?.bbId ?? null,
      seats,
      board: h?.board ?? [],
      board2: h?.board2 ?? [],
      split: split ?? null,
      target: h?.target ?? null,
      pot,
      toAct: h?.toAct ?? null,
      turnMsLeft: this.turnDeadline ? Math.max(0, this.turnDeadline - Date.now()) : null,
      turnMsTotal: this.turnTotal,
      currentBet,
      callAmount,
      minRaiseTo: Math.min(currentBet + (h?.minRaise ?? this.bb), maxRaiseTo),
      maxRaiseTo,
      myHandName,
      pending: h?.pending ?? null,
      myReady: !!me?.ready,
      pairs: !!(h && RULES[h.game].pairs),
      wild: !!(h && RULES[h.game].wild),
      blinds: { sb: this.sb, bb: this.bb },
      startingChips: this.startingChips,
      winners: h?.winners ?? [],
      log: this.log.slice(-12),
    };
  }
}
