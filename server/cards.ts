import { randomInt } from 'node:crypto';
import type { Card } from '../shared/types';

export const RANKS = '23456789TJQKA';
export const SUITS = 'shdc';

export function rankValue(card: Card): number {
  return RANKS.indexOf(card[0]) + 2;
}

/** A freshly shuffled 52-card deck. Uses crypto randomness so shuffles can't be predicted. */
export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
