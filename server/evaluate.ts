import type { Card } from '../shared/types';
import { RANKS, SUITS, rankValue } from './cards';

export interface HandScore { score: number; name: string; cards: Card[] }

const NAMES: Record<number, [string, string]> = {
  2: ['Two', 'Twos'], 3: ['Three', 'Threes'], 4: ['Four', 'Fours'], 5: ['Five', 'Fives'],
  6: ['Six', 'Sixes'], 7: ['Seven', 'Sevens'], 8: ['Eight', 'Eights'], 9: ['Nine', 'Nines'],
  10: ['Ten', 'Tens'], 11: ['Jack', 'Jacks'], 12: ['Queen', 'Queens'], 13: ['King', 'Kings'], 14: ['Ace', 'Aces'],
};
const one = (v: number) => NAMES[v][0];
const many = (v: number) => NAMES[v][1];

function describe(cat: number, tb: number[]): string {
  switch (cat) {
    case 8: return tb[0] === 14 ? 'Royal Flush' : `Straight Flush, ${one(tb[0])} high`;
    case 7: return `Four ${many(tb[0])}`;
    case 6: return `Full House, ${many(tb[0])} full of ${many(tb[1])}`;
    case 5: return `Flush, ${one(tb[0])} high`;
    case 4: return `Straight, ${one(tb[0])} high`;
    case 3: return `Three ${many(tb[0])}`;
    case 2: return `Two Pair, ${many(tb[0])} and ${many(tb[1])}`;
    case 1: return `Pair of ${many(tb[0])}`;
    default: return `${one(tb[0])} High`;
  }
}

/** Score 5 rank values. `flush` says whether all five share a suit. */
function scoreVals(input: number[], flush: boolean): { score: number; name: string } {
  const vals = [...input].sort((a, b) => b - a);
  const uniq = [...new Set(vals)];
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A-2-3-4-5
  }
  const counts = new Map<number, number>();
  for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const shape = groups.map(g => g[1]);
  const byGroup = groups.map(g => g[0]);

  let cat: number;
  let tb: number[];
  if (straightHigh && flush) { cat = 8; tb = [straightHigh]; }
  else if (shape[0] >= 4) { cat = 7; tb = byGroup; }
  else if (shape[0] === 3 && shape[1] === 2) { cat = 6; tb = byGroup; }
  else if (flush) { cat = 5; tb = vals; }
  else if (straightHigh) { cat = 4; tb = [straightHigh]; }
  else if (shape[0] === 3) { cat = 3; tb = byGroup; }
  else if (shape[0] === 2 && shape[1] === 2) { cat = 2; tb = byGroup; }
  else if (shape[0] === 2) { cat = 1; tb = byGroup; }
  else { cat = 0; tb = vals; }

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (tb[i] ?? 0);
  return { score, name: describe(cat, tb) };
}

/** Score exactly 5 cards. Higher score = better hand. */
export function eval5(cards: Card[]): HandScore {
  return { ...scoreVals(cards.map(rankValue), cards.every(c => c[1] === cards[0][1])), cards };
}

export function combinations<T>(items: T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i <= items.length - (k - acc.length); i++) {
      acc.push(items[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Best 5-card hand from any 5 of the given cards. */
export function bestHand(cards: Card[]): HandScore {
  let best: HandScore | null = null;
  for (const combo of combinations(cards, 5)) {
    const s = eval5(combo);
    if (!best || s.score > best.score) best = s;
  }
  return best!;
}

/** Best hand using exactly `use` of the hole cards plus any of the board (3 Card: best 2 of your 3). */
export function bestUsing(hole: Card[], board: Card[], use: number): HandScore {
  let best: HandScore | null = null;
  for (const picked of combinations(hole, Math.min(use, hole.length))) {
    const s = bestHand([...picked, ...board]);
    if (!best || s.score > best.score) best = s;
  }
  return best!;
}

const ALL_RANKS = [...RANKS].map((_, i) => i + 2).reverse(); // 14..2

/** All multisets of size k drawn from ALL_RANKS. */
function rankMultisets(k: number): number[][] {
  const out: number[][] = [];
  const go = (start: number, acc: number[]) => {
    if (acc.length === k) { out.push(acc.slice()); return; }
    for (let i = start; i < ALL_RANKS.length; i++) { acc.push(ALL_RANKS[i]); go(i, acc); acc.pop(); }
  };
  go(0, []);
  return out;
}

/**
 * Best hand when some cards are wild (AK47). A wild can stand in for any card,
 * but five of a kind isn't allowed, so the best possible hand is a royal flush.
 */
export function bestWild(cards: Card[], isWild: (c: Card) => boolean): HandScore {
  const naturals = cards.filter(c => !isWild(c));
  const w = cards.length - naturals.length;
  if (w === 0) return bestHand(cards);
  let best = { score: -1, name: '' };
  const consider = (s: { score: number; name: string }) => { if (s.score > best.score) best = s; };
  if (w >= 5) return { ...scoreVals([14, 13, 12, 11, 10], true), cards };

  // Flush and straight flush: every wild takes the suit we're building.
  for (const suit of SUITS) {
    const have = new Set(naturals.filter(c => c[1] === suit).map(rankValue));
    for (let high = 14; high >= 5; high--) {
      const window = high === 5 ? [14, 2, 3, 4, 5] : [0, 1, 2, 3, 4].map(d => high - d);
      if (window.filter(r => have.has(r)).length + w >= 5) { consider(scoreVals(window, true)); break; }
    }
    if (have.size + w >= 5) {
      const fill = ALL_RANKS.filter(r => !have.has(r)).slice(0, w);
      consider(scoreVals([...have, ...fill].sort((a, b) => b - a).slice(0, 5), true));
    }
  }

  // Everything else only depends on ranks: try every way the wilds could be valued.
  const natVals = naturals.map(rankValue);
  for (const wildVals of rankMultisets(w)) {
    for (const combo of combinations([...natVals, ...wildVals], 5)) {
      if (combo.every(v => v === combo[0])) continue; // no five of a kind
      consider(scoreVals(combo, false));
    }
  }
  return { ...best, cards };
}

/**
 * Worst 5-card hand from the cards (High-Low's Low board). Straights and flushes count
 * against you, so the best possible low is 7-5-4-3-2 of mixed suits.
 * The score is negated so that, like everywhere else, higher is better.
 */
export function worstHand(cards: Card[]): HandScore {
  let worst: HandScore | null = null;
  for (const combo of combinations(cards, 5)) {
    const s = eval5(combo);
    if (!worst || s.score < worst.score) worst = s;
  }
  const w = worst!;
  const highCardOnly = w.score < 15 ** 5;
  const ranks = w.cards.map(rankValue).sort((a, b) => b - a).map(v => (v === 10 ? '10' : RANKS[v - 2]));
  return { score: -w.score, name: highCardOnly ? ranks.join('-') : w.name, cards: w.cards };
}

// Triple 9 digits: A=1, 2-9 face value, 10/J/Q/K = 0.
const DIGIT: Record<string, number> = { A: 1, T: 0, J: 0, Q: 0, K: 0 };
export const digitOf = (c: Card) => DIGIT[c[0]] ?? Number(c[0]);

/** The best number 3 cards can make: closest to the target, or farthest from it. */
export function triple9Number(cards: Card[], target: number, farthest: boolean): { value: number; score: number; text: string } {
  const d = cards.map(digitOf);
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let best = { value: 0, score: -Infinity, text: '' };
  for (const [i, j, k] of orders) {
    const value = d[i] * 100 + d[j] * 10 + d[k];
    const dist = Math.abs(value - target);
    const score = farthest ? dist : -dist;
    if (score > best.score) best = { value, score, text: String(value).padStart(3, '0') };
  }
  return best;
}
