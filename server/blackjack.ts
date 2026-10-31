import { randomInt } from 'node:crypto';
import type { BJAction, Card } from '../shared/types';
import { RANKS, SUITS } from './cards';

/** Two 52-card decks shuffled together, so splits never run the shoe dry. */
export function shoe(): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < 2; d++) for (const r of RANKS) for (const s of SUITS) cards.push(r + s);
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

/** Blackjack value of one card: A counts 1 here (total() decides when it's 11), faces 10. */
export function cardValue(card: Card): number {
  const r = card[0];
  if (r === 'A') return 1;
  if ('TJQK'.includes(r)) return 10;
  return Number(r);
}

/** Best total; soft = an Ace is counting as 11. */
export function total(cards: Card[]): { total: number; soft: boolean } {
  let sum = 0;
  let aces = 0;
  for (const c of cards) { sum += cardValue(c); if (c[0] === 'A') aces++; }
  if (aces > 0 && sum + 10 <= 21) return { total: sum + 10, soft: true };
  return { total: sum, soft: false };
}

export const isBlackjack = (cards: Card[]) => cards.length === 2 && total(cards).total === 21;

/** The bank draws to 16 and stands on every 17, soft ones included. */
export const bankDraws = (cards: Card[]) => total(cards).total < 17;

/** What a hand gets back, stake included, against the bank's final cards. */
export function settleHand(
  cards: Card[], bet: number, natural: boolean, bank: Card[],
): { result: 'blackjack' | 'win' | 'push' | 'lose' | 'bust'; back: number } {
  const me = total(cards).total;
  const them = total(bank).total;
  const bankBJ = isBlackjack(bank);
  if (me > 21) return { result: 'bust', back: 0 };
  if (natural && !bankBJ) return { result: 'blackjack', back: bet + Math.floor((bet * 3) / 2) };
  if (bankBJ) return natural ? { result: 'push', back: bet } : { result: 'lose', back: 0 };
  if (them > 21 || me > them) return { result: 'win', back: bet * 2 };
  if (me === them) return { result: 'push', back: bet };
  return { result: 'lose', back: 0 };
}

/** Textbook basic strategy, trimmed down. `up` is the bank's face-up card. */
export function botMove(cards: Card[], up: Card, canDouble: boolean, canSplit: boolean): BJAction {
  const u = cardValue(up) === 1 ? 11 : cardValue(up);
  if (canSplit) {
    const v = cardValue(cards[0]);
    if (v === 1 || v === 8) return 'split';
    if (v === 9 && u !== 7 && u <= 9) return 'split';
    if ((v === 2 || v === 3 || v === 7) && u <= 7) return 'split';
    if (v === 6 && u <= 6) return 'split';
  }
  const { total: t, soft } = total(cards);
  if (canDouble) {
    if (!soft && t === 11) return 'double';
    if (!soft && t === 10 && u <= 9) return 'double';
    if (!soft && t === 9 && u >= 3 && u <= 6) return 'double';
    if (soft && t >= 15 && t <= 18 && u >= 4 && u <= 6) return 'double';
  }
  if (soft) return t >= 19 || (t === 18 && u <= 8) ? 'stand' : 'hit';
  if (t >= 17) return 'stand';
  if (t >= 13) return u <= 6 ? 'stand' : 'hit';
  if (t === 12) return u >= 4 && u <= 6 ? 'stand' : 'hit';
  return 'hit';
}
