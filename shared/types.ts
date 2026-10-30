// Amounts everywhere are integer cents (1000 = 10.00) so blinds like 0.10 stay exact.
export type Card = string; // rank + suit, e.g. "As", "Td", "7c"

export type GameId =
  | 'holdem' | 'irish' | 'three_card' | 'ak47' | 'triple9' | 'triple9_custom'
  | 'omaha5' | 'omaha6' | 'double_board' | 'high_low';

export interface GameInfo { id: GameId; name: string; blurb: string; ready: boolean }

export const GAMES: GameInfo[] = [
  { id: 'holdem', name: "Texas Hold'em", blurb: '2 cards, best 5 with the board', ready: true },
  { id: 'irish', name: 'Irish', blurb: '3 cards, drop 1 before betting starts', ready: true },
  { id: 'three_card', name: '3 Card', blurb: 'Keep 3, play your best 2', ready: true },
  { id: 'ak47', name: 'AK47', blurb: 'Every A, K, 4 and 7 is wild', ready: true },
  { id: 'triple9', name: 'Triple 9', blurb: '5 cards: 3 for 999, 2 for poker', ready: true },
  { id: 'triple9_custom', name: 'Triple 9 Custom', blurb: 'Dealer picks the target number', ready: true },
  { id: 'omaha5', name: '5 Card Omaha', blurb: '5 cards, drop 1 before each board', ready: true },
  { id: 'omaha6', name: '6 Card Omaha', blurb: 'Lock 3 pairs, drop a pair each street', ready: true },
  { id: 'double_board', name: 'Double Board', blurb: '4 cards, two boards, split pot', ready: true },
  { id: 'high_low', name: 'High-Low', blurb: 'Best hand on High, worst on Low', ready: true },
];

export type Phase = 'lobby' | 'choosing' | 'playing' | 'showdown';
export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown';
export type Action = 'fold' | 'check' | 'call' | 'raise' | 'allin';

/** A step where everyone acts at once instead of in turn. */
export type PendingKind = 'drop' | 'arrange' | 'drop_pair';
export interface Pending { kind: PendingKind; count: number }

/** Games where you split your hole cards into two hands, each playing for half the pot. */
export type SplitKind = 'triple9' | 'double' | 'highlow';
export const SPLITS: Record<SplitKind, { sizes: [number, number]; labels: [string, string] }> = {
  triple9: { sizes: [3, 2], labels: ['Number', 'Poker'] },
  double: { sizes: [2, 2], labels: ['Board 1', 'Board 2'] },
  highlow: { sizes: [2, 2], labels: ['High', 'Low'] },
};
export interface Target { value: number; farthest: boolean }

export const isAK47Wild = (card: Card) => 'AK47'.includes(card[0]);

export interface SeatView {
  id: string;
  name: string;
  chips: number;
  connected: boolean;
  bot: boolean;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  bet: number;
  cards: (Card | null)[]; // null = face down
  handName?: string;
  won?: number;
  waiting: boolean; // still has to drop / arrange cards
}

export interface TableView {
  code: string;
  you: string;
  hostId: string;
  phase: Phase;
  game: GameId | null;
  handNo: number;
  street: Street | null;
  dealerId: string | null;
  chooserId: string | null; // who picks the game (the dealer, or you in practice)
  practice: boolean;
  sbId: string | null;
  bbId: string | null;
  seats: SeatView[];
  board: Card[];
  board2: Card[]; // second board for Double Board and High-Low
  split: SplitKind | null;
  target: Target | null; // Triple 9
  pot: number; // collected from earlier streets (excludes bets in front of players)
  toAct: string | null;
  turnMsLeft: number | null;
  turnMsTotal: number;
  currentBet: number;
  callAmount: number;
  minRaiseTo: number;
  maxRaiseTo: number;
  myHandName: string | null;
  pending: Pending | null;
  myReady: boolean;
  pairs: boolean; // 6 Card Omaha: hole cards are held as consecutive pairs
  wild: boolean;  // AK47
  blinds: { sb: number; bb: number };
  startingChips: number;
  winners: { id: string; amount: number; handName?: string }[];
  log: string[];
}

export type ClientMsg =
  | { t: 'create'; name: string; startingChips: number; bb: number; bots?: number }
  | { t: 'join'; code: string; name: string; token?: string }
  | { t: 'start' }
  | { t: 'choose'; game: GameId; target?: number; farthest?: boolean }
  | { t: 'act'; action: Action; amount?: number }
  | { t: 'discard'; cards: Card[] }
  | { t: 'arrange'; cards: Card[] }
  | { t: 'rebuy' }
  | { t: 'leave' };

export type ServerMsg =
  | { t: 'joined'; code: string; token: string }
  | { t: 'state'; state: TableView }
  | { t: 'error'; message: string; fatal?: boolean }
  | { t: 'left' };

export function fmt(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}
