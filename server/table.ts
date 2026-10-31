import { randomUUID } from 'node:crypto';
import { CHAT_MAX, EMOTES, GAMES, SPLITS, fmt, isAK47Wild } from '../shared/types';
import type {
  Action, BJAction, BJResult, BJStep, BJView, Card, ChatMsg, GameId, Pending, Phase, PokerGameId, SeatView, SplitKind, Street,
  TableView, Target,
} from '../shared/types';
import { bankDraws, botMove, cardValue, isBlackjack, settleHand, shoe, total } from './blackjack';
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
const CHAT_KEEP = 50;
const CHAT_GAP_MS = 500;
const REACT_MS = 1_200;
const BJ_STEP_MS = 30_000; // betting and insurance, everyone at once
const BJ_DRAW_MS = 900;    // the bank turns its cards over one at a time
const BJ_DONE_MS = 7_000;

/** How each game differs from Hold'em. Drops happen as each street opens, before its betting. */
interface Rules {
  hole: number;
  drops?: Partial<Record<Street, number>>;
  pairs?: boolean;  // arrange into locked pairs before the flop; drops remove whole pairs
  use?: number;     // showdown uses exactly this many hole cards
  wild?: boolean;
  split?: SplitKind;
}
const RULES: Record<PokerGameId, Rules> = {
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
  bot: boolean;
}

const BOT_NAMES = ['Maverick', 'Queenie', 'Lucky', 'Dutch', 'Rio', 'Sly', 'Ace'];
const PRACTICE_CHOOSE_MS = 10 * 60_000;

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
  game: PokerGameId;
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

interface BJHand { cards: Card[]; bet: number; doubled: boolean; done: boolean; natural: boolean; splitAces: boolean; result?: BJResult }
interface BJPlayer {
  id: string;
  bet: number | null; // null = hasn't bet yet; 0 = sitting out
  hands: BJHand[];
  insurance: number | null;
  staked: number; // everything this player has put in this round
  net?: number;
}
interface BJRound {
  min: number;
  max: number;
  bankerId: string;
  step: BJStep;
  deck: Card[];
  dealer: Card[];
  holeShown: boolean;
  players: BJPlayer[]; // seat order from the bank's left
  active: { i: number; hand: number } | null;
  bankNet?: number;
}

export class Room {
  players: Player[] = [];
  hostId = '';
  phase: Phase = 'lobby';
  dealerId: string | null = null;
  private dealerSeat = -1;
  hand: Hand | null = null;
  bj: BJRound | null = null;
  handNo = 0;
  log: string[] = [];
  chat: ChatMsg[] = [];
  private chatSeq = 0;
  private lastChat = new Map<string, number>();
  private reactTimer: NodeJS.Timeout | null = null;
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

  /** Practice tables: bots fill the seats and the human picks every game. */
  practice = false;
  chooserId: string | null = null;
  private botTimer: NodeJS.Timeout | null = null;

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    if (this.botTimer) clearTimeout(this.botTimer);
    if (this.reactTimer) clearTimeout(this.reactTimer);
    this.timer = null;
    this.botTimer = null;
    this.reactTimer = null;
  }

  addBots(count: number) {
    for (const name of BOT_NAMES.slice(0, Math.max(1, Math.min(7, count)))) {
      const b = this.addPlayer(name);
      b.bot = true;
    }
  }

  // ---------- seating ----------

  addPlayer(name: string): Player {
    if (this.players.length >= MAX_PLAYERS) throw new GameError('Table is full');
    const used = new Set(this.players.map(p => p.seat));
    let seat = 0;
    while (used.has(seat)) seat++;
    const p: Player = {
      id: randomUUID(), token: randomUUID(), name: name.trim().slice(0, 14) || 'Player',
      seat, chips: this.startingChips, connected: true, leaving: false, bot: false,
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
    if (!connected && this.bj?.active && this.bj.players[this.bj.active.i].id === id) this.bjTurn();
  }

  leave(id: string) {
    const p = this.player(id);
    if (!p) return;
    const bj = this.bj;
    if (bj && (this.phase === 'playing' || this.phase === 'showdown') && (bj.bankerId === id || bj.players.some(y => y.id === id))) {
      // Stay seated until the round settles (the bank's chips still pay out); stand on anything left.
      p.leaving = true;
      const y = bj.players.find(z => z.id === id);
      if (y && bj.step === 'bet' && y.bet === null) this.bjBet(id, 0);
      else if (y && bj.step === 'insurance' && y.insurance === null) this.bjInsure(id, false);
      else if (y && bj.step === 'play') {
        const mine = bj.active && bj.players[bj.active.i] === y;
        for (const hand of y.hands) hand.done = true;
        if (mine) this.bjNext();
      }
      this.say(`${p.name} left`);
      if (this.hostId === id) this.hostId = this.players.find(q => !q.leaving)?.id ?? '';
      return;
    }
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
    if (this.phase === 'playing' && this.bj?.players.some(y => y.id === id && y.staked > 0)) throw new GameError('Finish this hand first');
    if (p.chips > 0) throw new GameError('You still have chips');
    p.chips = this.startingChips;
    this.say(`${p.name} rebought for ${fmt(this.startingChips)}`);
  }

  // ---------- chat ----------

  sendChat(id: string, text?: string, emote?: string) {
    const p = this.player(id);
    if (!p) return;
    const now = Date.now();
    if (now - (this.lastChat.get(id) ?? 0) < CHAT_GAP_MS) throw new GameError('Slow down');
    if (emote !== undefined) {
      if (!EMOTES.some(e => e.id === emote)) throw new GameError('Unknown emote');
      this.postChat(p, { emote });
    } else {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
      if (!clean) return;
      this.postChat(p, { text: clean });
    }
    this.lastChat.set(id, now);
  }

  private postChat(p: Player, body: { text?: string; emote?: string }) {
    this.chat.push({ id: ++this.chatSeq, from: p.id, name: p.name, ...body });
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
  }

  /** Practice bots sometimes gloat or sulk after a decent pot. */
  private botReact(byFold: boolean) {
    if (!this.practice || Math.random() < 0.5) return;
    const h = this.hand!;
    const big = this.bb * 4;
    const options: [string, string[]][] = [];
    for (const w of h.winners) {
      if (this.player(w.id)?.bot && w.amount >= big) options.push([w.id, byFold ? ['chicken', 'clown'] : ['fire', 'money', 'nuts']]);
    }
    if (!byFold) for (const x of h.hp.values()) {
      if (!x.won && x.total >= big && this.player(x.id)?.bot) options.push([x.id, ['salty', 'cry', 'skull']]);
    }
    this.queueReact(options);
  }

  private queueReact(options: [string, string[]][]) {
    if (!options.length) return;
    const [id, emotes] = options[Math.floor(Math.random() * options.length)];
    if (this.reactTimer) clearTimeout(this.reactTimer);
    this.reactTimer = setTimeout(() => {
      this.reactTimer = null;
      const p = this.player(id);
      if (!p) return;
      this.postChat(p, { emote: emotes[Math.floor(Math.random() * emotes.length)] });
      this.onChange();
    }, REACT_MS);
    this.reactTimer.unref?.();
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

  choose(by: string, game: GameId, target?: number, farthest?: boolean, limits?: { min: number; max: number }) {
    if (this.phase !== 'choosing') throw new GameError('Not choosing right now');
    if (by !== this.chooserId) throw new GameError('Only the dealer picks the game');
    const info = GAMES.find(g => g.id === game);
    if (!info?.ready) throw new GameError('That game is coming soon');
    const seated = this.players.filter(p => p.chips > 0 && !p.leaving).length;
    if (seated > info.maxPlayers) throw new GameError(`${info.name} fits at most ${info.maxPlayers} players`);
    if (game === 'blackjack') return this.startBlackjack(by, limits);
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
    this.bj = null;
    this.dealerId = dealer.id;
    this.dealerSeat = dealer.seat;
    this.phase = 'choosing';
    this.chooserId = this.practice ? this.players.find(p => !p.bot)?.id ?? dealer.id : dealer.id;
    const ms = this.practice ? PRACTICE_CHOOSE_MS : CHOOSE_MS;
    this.turnDeadline = Date.now() + ms;
    this.turnTotal = ms;
    this.say(`${dealer.name} is dealing`);
    this.schedule(ms, () => { if (this.phase === 'choosing') this.startHand('holdem'); });
  }

  private nextHand() {
    this.players = this.players.filter(p => !p.leaving);
    if (!this.player(this.hostId)) this.hostId = this.players[0]?.id ?? '';
    this.hand = null;
    this.bj = null;
    for (const b of this.players) {
      if (b.bot && b.chips === 0) { b.chips = this.startingChips; this.say(`${b.name} rebought`); }
    }
    const eligible = this.players.filter(p => p.chips > 0);
    // Nobody's looking: stop dealing until someone comes back and the host restarts.
    if (eligible.length < 2 || !this.players.some(p => p.connected && !p.bot)) {
      this.phase = 'lobby';
      this.dealerId = null;
      this.turnDeadline = null;
      this.say('Waiting for more players with chips');
      return;
    }
    const next = eligible.find(p => p.seat > this.dealerSeat) ?? eligible[0];
    this.beginChoosing(next);
  }

  private startHand(game: PokerGameId, target: Target | null = null) {
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

  // ---------- blackjack: the player who picked it is the bank ----------

  private startBlackjack(bankerId: string, limits?: { min: number; max: number }) {
    const banker = this.player(bankerId)!;
    const min = Math.floor(Number(limits?.min));
    const max = Math.floor(Number(limits?.max));
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) {
      throw new GameError('Set a min bet, and a max bet at least as big');
    }
    if (max > banker.chips) throw new GameError(`As the bank you need at least the max bet (${fmt(max)})`);
    const left = [...this.players.filter(p => p.seat > banker.seat), ...this.players.filter(p => p.seat < banker.seat)];
    const order = left.filter(p => !p.leaving && p.chips >= min);
    if (!order.length) throw new GameError('Nobody else has enough chips for the min bet');

    this.hand = null;
    this.handNo++;
    this.phase = 'playing';
    const bj: BJRound = {
      min, max, bankerId, step: 'bet', deck: shoe(), dealer: [], holeShown: false, active: null,
      players: order.map(p => ({ id: p.id, bet: null, hands: [], insurance: null, staked: 0 })),
    };
    this.bj = bj;
    this.say(`Hand #${this.handNo}: Blackjack, ${banker.name} is the bank (bets ${fmt(min)} to ${fmt(max)})`);
    this.timed(BJ_STEP_MS, () => {
      if (this.bj !== bj || bj.step !== 'bet') return;
      for (const y of bj.players) if (y.bet === null) y.bet = 0;
      this.bjDeal();
    });
    this.bjBots(() => {
      if (this.bj !== bj || bj.step !== 'bet') return;
      for (const y of bj.players) {
        const p = this.player(y.id)!;
        if (!p.bot || y.bet !== null) continue;
        const f = [0, 0, 0.25, 0.5, 1][Math.floor(Math.random() * 5)];
        const top = Math.min(bj.max, p.chips);
        const want = bj.min + Math.round(((top - bj.min) * f) / this.sb) * this.sb;
        this.bjBet(y.id, Math.max(bj.min, Math.min(top, want)));
      }
    });
  }

  private bjSeat(id: string) {
    const bj = this.bj;
    const y = bj?.players.find(z => z.id === id);
    if (!bj || this.phase !== 'playing') throw new GameError('No blackjack round right now');
    if (!y) throw new GameError(bj.bankerId === id ? "You're the bank this round" : "You're not in this round");
    return { bj, y, p: this.player(id)! };
  }

  bjBet(id: string, amount: number) {
    const { bj, y, p } = this.bjSeat(id);
    if (bj.step !== 'bet') throw new GameError('Betting is closed');
    if (y.bet !== null) throw new GameError('You already bet');
    const a = Math.floor(Number(amount));
    if (a === 0) {
      y.bet = 0;
      this.say(`${p.name} sits this one out`);
    } else {
      if (!Number.isFinite(a) || a < bj.min || a > bj.max) throw new GameError(`Bet from ${fmt(bj.min)} to ${fmt(bj.max)}`);
      if (a > p.chips) throw new GameError('Not enough chips');
      p.chips -= a;
      y.bet = a;
      y.staked = a;
      y.hands = [{ cards: [], bet: a, doubled: false, done: false, natural: false, splitAces: false }];
      this.say(`${p.name} bets ${fmt(a)}`);
    }
    if (bj.players.every(z => z.bet !== null)) this.bjDeal();
  }

  private bjDeal() {
    const bj = this.bj!;
    const playing = bj.players.filter(y => y.bet);
    if (!playing.length) {
      this.say('Nobody bet');
      bj.step = 'done';
      this.phase = 'showdown';
      this.turnDeadline = null;
      this.schedule(2_500, () => this.nextHand());
      return;
    }
    for (let round = 0; round < 2; round++) {
      for (const y of playing) y.hands[0].cards.push(bj.deck.pop()!);
      bj.dealer.push(bj.deck.pop()!);
    }
    for (const y of playing) {
      const hand = y.hands[0];
      hand.natural = isBlackjack(hand.cards);
      hand.done = hand.natural;
    }
    if (bj.dealer[0][0] !== 'A') return this.bjAfterInsurance();

    bj.step = 'insurance';
    for (const y of bj.players) {
      const cost = Math.floor((y.bet ?? 0) / 2);
      y.insurance = y.bet && cost > 0 && this.player(y.id)!.chips >= cost ? null : 0;
    }
    if (bj.players.every(y => y.insurance !== null)) return this.bjAfterInsurance();
    this.timed(BJ_STEP_MS, () => {
      if (this.bj !== bj || bj.step !== 'insurance') return;
      for (const y of bj.players) if (y.insurance === null) y.insurance = 0;
      this.bjAfterInsurance();
    });
    this.bjBots(() => {
      if (this.bj !== bj || bj.step !== 'insurance') return;
      for (const y of bj.players) if (this.player(y.id)!.bot && y.insurance === null) this.bjInsure(y.id, false);
    });
  }

  bjInsure(id: string, take: boolean) {
    const { bj, y, p } = this.bjSeat(id);
    if (bj.step !== 'insurance' || y.insurance !== null) throw new GameError('No insurance to decide right now');
    const cost = Math.floor(y.bet! / 2);
    if (take) {
      if (p.chips < cost) throw new GameError('Not enough chips');
      p.chips -= cost;
      y.staked += cost;
      y.insurance = cost;
      this.say(`${p.name} takes insurance`);
    } else y.insurance = 0;
    if (bj.players.every(z => z.insurance !== null)) this.bjAfterInsurance();
  }

  /** The bank peeks when it shows an Ace or a ten: a blackjack ends the round on the spot. */
  private bjAfterInsurance() {
    const bj = this.bj!;
    const up = cardValue(bj.dealer[0]);
    if ((up === 1 || up === 10) && isBlackjack(bj.dealer)) {
      this.say(`${this.player(bj.bankerId)!.name}'s bank has Blackjack`);
      return this.bjSettle();
    }
    bj.step = 'play';
    this.bjNext();
  }

  /** Move to the first unfinished hand, or let the bank play once every hand is done. */
  private bjNext() {
    const bj = this.bj!;
    for (let i = 0; i < bj.players.length; i++) {
      const y = bj.players[i];
      for (let k = 0; k < y.hands.length; k++) {
        const hand = y.hands[k];
        if (!hand.done && total(hand.cards).total >= 21) hand.done = true;
        if (hand.done) continue;
        bj.active = { i, hand: k };
        return this.bjTurn();
      }
    }
    this.bjBank();
  }

  private bjTurn() {
    const bj = this.bj!;
    const a = bj.active!;
    const y = bj.players[a.i];
    const p = this.player(y.id);
    const ms = p?.connected && !p.leaving ? TURN_MS : AWAY_TURN_MS;
    this.timed(ms, () => { if (this.bj === bj && bj.active === a) this.bjAct(y.id, 'stand'); });
    if (p?.bot) {
      this.bjBots(() => {
        if (this.bj !== bj || bj.active !== a) return;
        const hand = y.hands[a.hand];
        const can = this.bjCan(y, hand);
        this.bjAct(y.id, botMove(hand.cards, bj.dealer[0], can.double, can.split));
      });
    }
  }

  private bjCan(y: BJPlayer, hand: BJHand) {
    const chips = this.player(y.id)!.chips;
    const two = hand.cards.length === 2 && !hand.splitAces && !hand.done;
    return {
      double: two && chips >= hand.bet,
      split: two && hand.cards[0][0] === hand.cards[1][0] && y.hands.length < 4 && chips >= hand.bet,
    };
  }

  bjAct(id: string, action: BJAction) {
    const bj = this.bj;
    if (!bj || this.phase !== 'playing' || bj.step !== 'play' || !bj.active) throw new GameError("It's not your turn");
    const y = bj.players[bj.active.i];
    if (y.id !== id) throw new GameError("It's not your turn");
    const hand = y.hands[bj.active.hand];
    const p = this.player(id)!;
    const can = this.bjCan(y, hand);
    switch (action) {
      case 'hit':
        hand.cards.push(bj.deck.pop()!);
        this.say(`${p.name} hits: ${total(hand.cards).total}`);
        break;
      case 'stand':
        hand.done = true;
        this.say(`${p.name} stands on ${total(hand.cards).total}`);
        break;
      case 'double':
        if (!can.double) throw new GameError("You can't double now");
        p.chips -= hand.bet;
        y.staked += hand.bet;
        hand.bet *= 2;
        hand.doubled = true;
        hand.cards.push(bj.deck.pop()!);
        hand.done = true;
        this.say(`${p.name} doubles: ${total(hand.cards).total}`);
        break;
      case 'split': {
        if (!can.split) throw new GameError("You can't split now");
        p.chips -= hand.bet;
        y.staked += hand.bet;
        const aces = hand.cards[0][0] === 'A';
        const other: BJHand = { cards: [hand.cards.pop()!], bet: hand.bet, doubled: false, done: false, natural: false, splitAces: aces };
        hand.splitAces = aces;
        hand.cards.push(bj.deck.pop()!);
        other.cards.push(bj.deck.pop()!);
        // Split Aces get one card each.
        if (aces) hand.done = other.done = true;
        y.hands.splice(bj.active.hand + 1, 0, other);
        this.say(`${p.name} splits`);
        break;
      }
      default:
        throw new GameError('Unknown move');
    }
    this.bjNext();
  }

  /** Every hand is done: the bank turns over its card and draws to 17, one card at a time. */
  private bjBank() {
    const bj = this.bj!;
    bj.active = null;
    bj.step = 'bank';
    bj.holeShown = true;
    this.turnDeadline = null;
    this.schedule(BJ_DRAW_MS, () => this.bjBankStep());
  }

  private bjBankStep() {
    const bj = this.bj;
    if (!bj || bj.step !== 'bank') return;
    // Nothing left to beat if every hand busted or was a blackjack.
    const needed = bj.players.some(y => y.hands.some(hand => !hand.natural && total(hand.cards).total <= 21));
    if (needed && bankDraws(bj.dealer)) {
      bj.dealer.push(bj.deck.pop()!);
      this.schedule(BJ_DRAW_MS, () => this.bjBankStep());
    } else this.bjSettle();
  }

  /**
   * Losing bets go to the bank first. Then winners are paid from the bank in seat order
   * from its left until it runs dry.
   */
  private bjSettle() {
    const bj = this.bj!;
    bj.holeShown = true;
    bj.active = null;
    bj.step = 'done';
    this.phase = 'showdown';
    this.turnDeadline = null;
    const banker = this.player(bj.bankerId)!;
    const bankBJ = isBlackjack(bj.dealer);
    let bankIn = 0;
    const owed: { y: BJPlayer; profit: number }[] = [];
    for (const y of bj.players) {
      if (!y.bet) continue;
      let back = 0;
      let profit = 0;
      for (const hand of y.hands) {
        const r = settleHand(hand.cards, hand.bet, hand.natural, bj.dealer);
        hand.result = r.result;
        if (r.back === 0) bankIn += hand.bet;
        else { back += hand.bet; profit += r.back - hand.bet; }
      }
      if (y.insurance) {
        if (bankBJ) { back += y.insurance; profit += y.insurance * 2; } else bankIn += y.insurance;
      }
      this.player(y.id)!.chips += back;
      y.net = back - y.staked;
      owed.push({ y, profit });
    }
    banker.chips += bankIn;
    let bankNet = bankIn;
    for (const { y, profit } of owed) {
      const pay = Math.min(profit, banker.chips);
      banker.chips -= pay;
      this.player(y.id)!.chips += pay;
      y.net! += pay;
      bankNet -= pay;
      if (pay < profit) this.say(`The bank ran dry: ${this.player(y.id)!.name} gets ${fmt(pay)} of ${fmt(profit)}`);
    }
    bj.bankNet = bankNet;
    const sign = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : 'even');
    this.say(`Bank ${total(bj.dealer).total > 21 ? 'busts' : `has ${total(bj.dealer).total}`}: ` +
      [...owed.map(o => `${this.player(o.y.id)!.name} ${sign(o.y.net!)}`), `${banker.name} ${sign(bankNet)}`].join(', '));
    this.bjReact();
    this.schedule(BJ_DONE_MS, () => this.nextHand());
  }

  private bjReact() {
    const bj = this.bj!;
    if (!this.practice || Math.random() < 0.5) return;
    const big = this.bb * 4;
    const options: [string, string[]][] = [];
    for (const y of bj.players) {
      if (!this.player(y.id)?.bot || y.net === undefined) continue;
      if (y.net >= big) options.push([y.id, ['fire', 'money', 'nuts']]);
      if (y.net <= -big) options.push([y.id, ['salty', 'cry', 'skull']]);
    }
    this.queueReact(options);
  }

  private bjBots(fn: () => void) {
    if (this.bj?.players.some(y => this.player(y.id)?.bot)) this.botSchedule(fn);
  }

  /** A deadline everyone can see as a countdown. */
  private timed(ms: number, fn: () => void) {
    this.turnDeadline = Date.now() + ms;
    this.turnTotal = ms;
    this.schedule(ms, fn);
  }

  private bjView(forId: string): BJView {
    const bj = this.bj!;
    const a = bj.active;
    const activeId = a ? bj.players[a.i].id : null;
    const mine = bj.players.find(y => y.id === forId);
    const can = a && activeId === forId ? this.bjCan(mine!, mine!.hands[a.hand]) : { double: false, split: false };
    const shown = bj.holeShown ? bj.dealer : bj.dealer.slice(0, 1);
    return {
      min: bj.min,
      max: bj.max,
      bankerId: bj.bankerId,
      step: bj.step,
      players: bj.players.map(y => ({
        id: y.id, bet: y.bet, insurance: y.insurance, net: y.net,
        hands: y.hands.map(hand => ({
          cards: hand.cards, bet: hand.bet, ...total(hand.cards), doubled: hand.doubled, done: hand.done, result: hand.result,
        })),
      })),
      dealer: bj.dealer.map((c, i) => (i === 1 && !bj.holeShown ? null : c)),
      dealerTotal: shown.length ? total(shown).total : null,
      bankNet: bj.bankNet,
      active: a ? { id: activeId!, hand: a.hand } : null,
      canDouble: can.double,
      canSplit: can.split,
      insuranceCost: Math.floor((mine?.bet ?? 0) / 2),
    };
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
    if (this.live().some(x => this.player(x.id)?.bot)) {
      this.botSchedule(() => {
        if (this.handNo !== handNo || this.hand?.street !== street || !this.hand.pending) return;
        const bots = this.live().filter(x => !x.ready && this.player(x.id)?.bot);
        for (const x of bots) this.autoPending(x);
        if (this.live().every(l => l.ready)) this.finishPending();
      });
    }
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
    if (this.player(id)?.bot) {
      this.botSchedule(() => {
        if (this.handNo !== handNo || this.hand?.toAct !== id || this.phase !== 'playing') return;
        const d = this.botDecide(id);
        try { this.act(id, d.action, d.amount); } catch { this.act(id, 'call'); }
      });
    }
  }

  // ---------- practice bots ----------

  private botSchedule(fn: () => void) {
    if (this.botTimer) clearTimeout(this.botTimer);
    // A short, slightly random pause so bots feel like people thinking.
    this.botTimer = setTimeout(() => {
      this.botTimer = null;
      try { fn(); } catch (e) { console.error(e); }
      this.onChange();
    }, 900 + Math.random() * 1100);
    this.botTimer.unref();
  }

  /** Rough 0..1 hand strength: good enough to make bots play sensibly, not well. */
  private botStrength(x: HandPlayer): number {
    const h = this.hand!;
    const catStrength = (score: number) => [0.2, 0.45, 0.62, 0.74, 0.8, 0.85, 0.92, 0.97, 1][Math.floor(score / 15 ** 5)] ?? 0.3;
    if (h.board.length === 0) {
      const vals = x.hole.map(rankValue).sort((a, b) => b - a);
      const pair = vals.some((v, i) => vals.indexOf(v) !== i);
      const top = (vals[0] + (vals[1] ?? 0)) / 28;
      return Math.min(1, (pair ? 0.55 : 0.15) + top * 0.4 + (h.game === 'ak47' ? 0.1 : 0));
    }
    const kind = RULES[h.game].split;
    if (!kind) return catStrength(this.evaluate(x).score);
    const halves = this.halves(x);
    if (kind === 'triple9') return (Math.min(1, 1 - Math.abs(halves[0].score) / 500) + catStrength(halves[1].score)) / 2;
    if (kind === 'highlow') return (catStrength(halves[0].score) + (halves[1].score > -(15 ** 5) ? 0.7 : 0.2)) / 2;
    return (catStrength(halves[0].score) + catStrength(halves[1].score)) / 2;
  }

  private botDecide(id: string): { action: Action; amount?: number } {
    const h = this.hand!;
    const x = h.hp.get(id)!;
    const p = this.player(id)!;
    const toCall = h.currentBet - x.bet;
    let pot = 0;
    for (const o of h.hp.values()) pot += o.total;
    const strength = this.botStrength(x) + (Math.random() - 0.5) * 0.15;
    const r = Math.random();
    const raiseTo = () => {
      const want = h.currentBet + Math.max(h.minRaise, Math.round((pot * (0.4 + r * 0.4)) / this.sb) * this.sb);
      return Math.min(want, x.bet + p.chips);
    };
    if (toCall <= 0) {
      if ((strength > 0.68 && r < 0.65) || r < 0.07) return { action: 'raise', amount: raiseTo() };
      return { action: 'check' };
    }
    const price = toCall / (pot + toCall);
    if (strength > 0.85 && r < 0.45) return { action: 'raise', amount: raiseTo() };
    if (strength > price + 0.12 || r < 0.08 || toCall <= this.bb) return { action: 'call' };
    return { action: 'fold' };
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
    this.botReact(false);
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
    this.botReact(true);
    this.schedule(FOLD_WIN_MS, () => this.nextHand());
  }

  // ---------- what each player is allowed to see ----------

  view(forId: string): TableView {
    const h = this.hand;
    const me = h?.hp.get(forId);
    const myChips = this.player(forId)?.chips ?? 0;
    const bj = this.bj;
    const seats: SeatView[] = this.players.map(p => {
      const x = h?.hp.get(p.id);
      const y = bj?.players.find(z => z.id === p.id);
      if (bj) {
        return {
          id: p.id, name: p.name, chips: p.chips, connected: p.connected, bot: p.bot,
          inHand: !!y?.bet || p.id === bj.bankerId, folded: false, allIn: false,
          bet: bj.step === 'done' ? 0 : y?.staked ?? 0, cards: [],
          won: Math.max(0, (p.id === bj.bankerId ? bj.bankNet : y?.net) ?? 0) || undefined,
          waiting: (bj.step === 'bet' && y?.bet === null) || (bj.step === 'insurance' && y?.insurance === null),
        };
      }
      let cards: (Card | null)[] = [];
      if (x && (!x.folded || p.id === forId)) {
        const show = p.id === forId || (h!.revealed && !x.folded);
        cards = x.hole.map(c => (show ? c : null));
      }
      return {
        id: p.id, name: p.name, chips: p.chips, connected: p.connected, bot: p.bot,
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
      game: bj ? 'blackjack' : h?.game ?? null,
      handNo: this.handNo,
      street: h?.street ?? null,
      dealerId: this.dealerId,
      chooserId: this.chooserId,
      practice: this.practice,
      sbId: h?.sbId ?? null,
      bbId: h?.bbId ?? null,
      seats,
      board: h?.board ?? [],
      board2: h?.board2 ?? [],
      split: split ?? null,
      target: h?.target ?? null,
      pot,
      toAct: bj ? bj.active && bj.players[bj.active.i].id : h?.toAct ?? null,
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
      chat: this.chat,
      bj: bj ? this.bjView(forId) : null,
    };
  }
}
