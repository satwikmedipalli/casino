import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestHand, bestUsing, bestWild, eval5, triple9Number, worstHand } from './evaluate';
import { isAK47Wild } from '../shared/types';
import { Room } from './table';

const score = (s: string) => eval5(s.split(' ')).score;

test('hand ranking order', () => {
  const ladder = [
    'As Ks Qs Js Ts', // royal
    '9h 8h 7h 6h 5h', // straight flush
    '5d 4d 3d 2d Ad', // steel wheel
    'Qc Qd Qh Qs 2c', // quads
    'Kc Kd Kh 2s 2c', // full house
    'Ah 9h 7h 4h 2h', // flush
    'Tc 9d 8h 7s 6c', // straight
    '5c 4d 3h 2s Ac', // wheel
    '7c 7d 7h Ks 2c', // trips
    'Jc Jd 4h 4s Ac', // two pair, ace kicker
    'Jc Jd 4h 4s Kc', // two pair, king kicker
    'Ac Ad 9h 5s 2c', // pair
    'Ac Qd 9h 5s 2c', // high card
  ];
  for (let i = 1; i < ladder.length; i++) {
    assert.ok(score(ladder[i - 1]) > score(ladder[i]), `${ladder[i - 1]} should beat ${ladder[i]}`);
  }
  assert.equal(score('Ah Kd 9c 5s 2h'), score('As Kc 9d 5h 2s'));
});

test('best of seven and names', () => {
  assert.equal(bestHand('As Ks Qs Js Ts 2c 3d'.split(' ')).name, 'Royal Flush');
  assert.equal(bestHand('Kh Kd 2c 2s 2h 9d 4c'.split(' ')).name, 'Full House, Twos full of Kings');
  assert.equal(bestHand('Ac 2d 3h 4s 5c Kd Qc'.split(' ')).name, 'Straight, Five high');
});

function table(stacks: number[], bb = 20) {
  const room = new Room('TEST', 1000, bb, () => {});
  const ps = stacks.map((c, i) => { const p = room.addPlayer(`P${i}`); p.chips = c; return p; });
  return { room, ps };
}

test('heads up: dealer posts small blind and acts first preflop, BB acts first after', () => {
  const { room, ps } = table([1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'holdem');
  const h = room.hand!;
  assert.equal(h.sbId, room.dealerId);
  assert.equal(h.toAct, room.dealerId);
  room.act(room.dealerId!, 'call');
  assert.equal(h.toAct, h.bbId);
  room.act(h.bbId, 'check');
  assert.equal(h.board.length, 3);
  assert.equal(h.toAct, h.bbId);
  room.dispose();
});

test('side pots with three all-ins of different sizes', () => {
  const { room, ps } = table([100, 300, 600]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'holdem');
  const h = room.hand!;
  // Rig the cards: P0 best, P1 second, P2 worst.
  h.hp.get(ps[0].id)!.hole = ['As', 'Ad'];
  h.hp.get(ps[1].id)!.hole = ['Ks', 'Kd'];
  h.hp.get(ps[2].id)!.hole = ['7c', '2d'];
  // Cards come off the end: burn, 3h 8c 9s, burn, Jd, burn, 4c.
  h.deck = ['4c', '2s', 'Jd', '2h', '9s', '8c', '3h', '2c'];
  while (room.phase === 'playing' && h.toAct) room.act(h.toAct, 'allin');
  // Run out the board synchronously.
  while (room.phase === 'playing') (room as any).endStreet();
  assert.equal(room.phase, 'showdown');
  const chips = Object.fromEntries(ps.map(p => [p.name, p.chips]));
  assert.deepEqual(chips, { P0: 300, P1: 400, P2: 300 });
  room.dispose();
});

test('fold to a raise awards the pot and keeps chips conserved', () => {
  const { room, ps } = table([1000, 1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'holdem');
  const h = room.hand!;
  const first = h.toAct!;
  room.act(first, 'raise', 60);
  room.act(h.toAct!, 'fold');
  room.act(h.toAct!, 'fold');
  assert.equal(room.phase, 'showdown');
  assert.equal(room.player(first)!.chips, 1030);
  assert.equal(room.players.reduce((s, p) => s + p.chips, 0), 3000);
  room.dispose();
});

test('cannot raise below the minimum, short all-in call is allowed', () => {
  const { room, ps } = table([1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'holdem');
  const h = room.hand!;
  const sb = h.sbId;
  room.player(h.bbId)!.chips = 15; // BB has 15 behind after posting 20
  assert.throws(() => room.act(sb, 'raise', 30), /Minimum is 0.40/);
  room.act(sb, 'raise', 100);
  room.act(h.bbId, 'allin');
  while (room.phase === 'playing') (room as any).endStreet();
  assert.equal(room.players.reduce((s, p) => s + p.chips, 0), 1035);
  room.dispose();
});

test('AK47 wild cards', () => {
  const w = (s: string) => bestWild(s.split(' '), isAK47Wild).name;
  assert.equal(w('Qs Qd 9c 8h 2s 3d 5c'), 'Pair of Queens'); // no wilds
  assert.equal(w('As Qd 9c 8h 2s 3d 5c'), 'Pair of Queens'); // wild ace pairs the queen
  assert.equal(w('Ah 4d Qs Qd 9c 8h 2s'), 'Four Queens'); // two wilds + pair, no five of a kind
  assert.equal(w('Kh Ts Js Qs 2c 3d 5c'), 'Pair of Queens'); // one wild can't finish T-J-Q
  assert.equal(w('Kh Ts Js Qs 9s 3d 5c'), 'Straight Flush, King high'); // wild becomes the K of spades
  assert.equal(w('Kh Ad Js Qs Ts 3d 5c'), 'Royal Flush'); // two wilds fill A and K of spades
  assert.equal(w('Ah Ks 4d 7c Qs 2d 3c'), 'Royal Flush'); // four wilds + Q
  assert.equal(w('Ah Ks 4d 7c 9s 2d 3c'), 'Straight Flush, King high'); // 9 natural + 4 wilds: 9-K spades
  assert.equal(w('As Kd 4h 7c Ac Kh 4s'), 'Royal Flush'); // seven wilds
  assert.equal(w('7s 9h 8d Tc 2s 3h 5c'), 'Pair of Tens'); // 8-9-T plus one wild is only 4 to a straight
  assert.equal(w('7s 9h 8d Tc Js 3h 2c'), 'Straight, Queen high'); // wild 7 becomes the Q
});

test('3 Card plays the best 2 of 3', () => {
  // 8-9-T in hand with J-Q on board is a straight in Hold'em, but only 2 of the 3 may play.
  const board = ['Jd', 'Qs', '2c', '3d', '5h'];
  assert.equal(bestHand(['8h', '9h', 'Tc', ...board]).name, 'Straight, Queen high');
  assert.equal(bestUsing(['8h', '9h', 'Tc'], board, 2).name, 'Queen High');
});

function playTo(room: Room, until: (r: Room) => boolean) {
  for (let i = 0; i < 200 && !until(room); i++) {
    const h = room.hand!;
    if (h.pending) {
      for (const x of h.hp.values()) {
        if (x.folded || x.ready) continue;
        if (h.pending.kind === 'arrange') room.arrange(x.id, [...x.hole]);
        else if (h.pending.kind === 'drop_pair') room.discard(x.id, x.hole.slice(0, 2));
        else room.discard(x.id, x.hole.slice(0, h.pending.count));
      }
    } else if (h.toAct) room.act(h.toAct, 'call');
    else break;
  }
}

test('5 Card Omaha drops one before each board street, 2 left for the river', () => {
  const { room, ps } = table([1000, 1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'omaha5');
  const h = room.hand!;
  assert.equal([...h.hp.values()][0].hole.length, 5);
  assert.equal(h.pending?.kind, 'drop');
  assert.equal(h.toAct, null);
  assert.throws(() => room.act(h.bbId, 'check'));
  const counts: Record<string, number> = {};
  for (let i = 0; i < 100 && room.phase === 'playing'; i++) {
    if (h.pending) {
      for (const x of h.hp.values()) if (!x.ready) room.discard(x.id, x.hole.slice(0, 1));
    } else {
      counts[h.street] = [...h.hp.values()][0].hole.length; // cards held while betting
      room.act(h.toAct!, 'call');
    }
  }
  assert.deepEqual(counts, { preflop: 4, flop: 3, turn: 2, river: 2 });
  assert.equal(room.phase, 'showdown');
  assert.equal(room.players.reduce((s, p) => s + p.chips, 0), 3000);
  room.dispose();
});

test('6 Card Omaha locks pairs and drops whole pairs', () => {
  const { room, ps } = table([1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'omaha6');
  const h = room.hand!;
  assert.equal(h.pending?.kind, 'arrange');
  const x = h.hp.get(ps[0].id)!;
  const order = [...x.hole].reverse();
  room.arrange(ps[0].id, order);
  assert.deepEqual(x.hole, order);
  assert.throws(() => room.arrange(ps[0].id, order), /Already done/);
  room.arrange(ps[1].id, [...h.hp.get(ps[1].id)!.hole]);
  assert.equal(h.pending, null);
  playTo(room, r => r.hand!.street === 'flop' && !!r.hand!.pending);
  assert.equal(room.hand!.pending?.kind, 'drop_pair');
  assert.throws(() => room.discard(ps[0].id, [x.hole[1], x.hole[2]]), /pairs/);
  const keep = x.hole.slice(2);
  room.discard(ps[0].id, x.hole.slice(0, 2));
  assert.deepEqual(x.hole, keep);
  playTo(room, r => r.phase !== 'playing');
  assert.equal(x.hole.length, 2);
  room.dispose();
});

test('Irish: 3 cards, drop 1 before preflop betting', () => {
  const { room, ps } = table([1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'irish');
  const h = room.hand!;
  assert.equal(h.pending?.kind, 'drop');
  assert.equal(h.pending?.count, 1);
  playTo(room, r => !r.hand!.pending);
  assert.ok([...h.hp.values()].every(x => x.hole.length === 2));
  assert.equal(h.street, 'preflop');
  assert.ok(h.toAct);
  room.dispose();
});

test('Triple 9 numbers', () => {
  assert.equal(triple9Number(['9s', '9d', '9h'], 999, false).value, 999);
  assert.equal(triple9Number(['Ks', '9d', 'Ah'], 999, false).value, 910); // K=0, A=1 -> best is 910
  assert.equal(triple9Number(['8s', '2d', '5h'], 500, false).value, 528);
  assert.equal(triple9Number(['8s', '2d', '5h'], 500, true).value, 852); // farthest from 500 (352 away)
  assert.equal(triple9Number(['Ts', 'Jd', '3h'], 999, false).text, '300');
});

test('Low hand: worst poker hand wins, straights and flushes count against you', () => {
  const low = (s: string) => worstHand(s.split(' '));
  assert.equal(low('7s 5d 4h 3c 2s Kd Kc').name, '7-5-4-3-2');
  assert.ok(low('7s 5d 4h 3c 2s').score > low('8s 5d 4h 3c 2s').score);
  assert.ok(low('8s 5d 4h 3c 2s').score > low('6s 5d 4h 3c 2s').score); // 6-high straight is a bad low
  assert.ok(low('9h 7h 5h 3h 2h').score < low('9h 7d 5h 3h 2h').score); // flush is worse than 9-high
});

function rigSplit(room: Room, holes: Record<string, string>, board: string, board2?: string) {
  const h = room.hand!;
  for (const [name, cards] of Object.entries(holes)) h.hp.get(room.players.find(p => p.name === name)!.id)!.hole = cards.split(' ');
  // Deck pops from the end: per street burn + board cards, then (two boards) burn + board2 cards.
  const b1 = board.split(' ');
  const b2 = board2?.split(' ');
  const seq: string[] = [];
  const street = (from: number, n: number) => {
    seq.push('Xx', ...b1.slice(from, from + n));
    if (b2) seq.push('Xx', ...b2.slice(from, from + n));
  };
  street(0, 3); street(3, 1); street(4, 1);
  h.deck = seq.reverse();
}

test('Triple 9 splits the pot between closest number and best poker hand', () => {
  const { room, ps } = table([1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'triple9');
  // P0: 9 9 8 for the number (998), junk poker. P1: weak number, aces for poker.
  rigSplit(room, { P0: '9s 9d 8h 2c 3d', P1: '5s 5d 6h Ac Ad' }, 'Ah Kc Qs 7d 4c');
  for (let i = 0; i < 20 && room.phase === 'playing'; i++) room.act(room.hand!.toAct!, 'call');
  assert.equal(room.phase, 'showdown');
  const w = Object.fromEntries(room.hand!.winners.map(x => [room.player(x.id)!.name, x.amount]));
  assert.deepEqual(w, { P0: 20, P1: 20 });
  assert.match(room.hand!.winners.find(x => room.player(x.id)!.name === 'P1')!.handName!, /Poker: Three Aces/);
  room.dispose();
});

test('Triple 9 Custom validates the number and supports farthest mode', () => {
  const { room, ps } = table([1000, 1000]);
  room.start(ps[0].id);
  assert.throws(() => room.choose(room.dealerId!, 'triple9_custom', 1200), /0 to 999/);
  room.choose(room.dealerId!, 'triple9_custom', 500, true);
  assert.deepEqual(room.hand!.target, { value: 500, farthest: true });
  room.dispose();
});

test('Double Board deals two boards and players can rearrange until showdown', () => {
  const { room, ps } = table([1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'double_board');
  // P0 plays KK on board 1 and 22 on board 2 by default; swaps so 22 hits a set on board 1... then swaps back.
  rigSplit(room, { P0: 'Ks Kd 2s 2d', P1: 'Qs Qd Js Jd' }, '2h 7c 8d 9s 3c', 'Kh 4c 5d 6s Th');
  const p0 = ps[0].id;
  room.arrange(p0, ['2s', '2d', 'Ks', 'Kd']); // 22 -> board 1 (set of twos), KK -> board 2 (set of kings)
  assert.throws(() => room.arrange(p0, ['2s', '2d', 'Ks', 'Ks']), /each of your cards/);
  for (let i = 0; i < 20 && room.phase === 'playing'; i++) room.act(room.hand!.toAct!, 'call');
  assert.equal(room.hand!.board.length, 5);
  assert.equal(room.hand!.board2.length, 5);
  assert.deepEqual(room.hand!.winners.map(x => [room.player(x.id)!.name, x.amount]), [['P0', 40]]);
  assert.throws(() => room.arrange(p0, ['Ks', 'Kd', '2s', '2d']), /Too late/);
  room.dispose();
});

test('High-Low pays the best High hand and the worst Low hand', () => {
  const { room, ps } = table([1000, 1000]);
  room.start(ps[0].id);
  room.choose(room.dealerId!, 'high_low');
  rigSplit(room, { P0: 'As Ad 7c 2d', P1: 'Ks Kd 9c 8d' }, 'Ah 5c Jd Qs 3h', 'Kc 4h 5s Th 3d');
  room.arrange(ps[0].id, ['As', 'Ad', '7c', '2d']);
  room.arrange(ps[1].id, ['Ks', 'Kd', '9c', '8d']);
  for (let i = 0; i < 20 && room.phase === 'playing'; i++) room.act(room.hand!.toAct!, 'call');
  // P0: three aces on High; low 7-5-4-3-2 beats P1's 9-8-5-4-3.
  assert.deepEqual(room.hand!.winners.map(x => [room.player(x.id)!.name, x.amount]), [['P0', 40]]);
  room.dispose();
});
