import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDice, hasScoring, usableDice, newGameState, applyRoll, applyKeep, applyPass, applyOffer, checkKeep, chooseBotAction, chooseBotOffer } from '../shared/rules.js';

const seq = (...vals) => { let i = 0; return () => vals[i++ % vals.length]; };

test('singles', () => {
  assert.equal(scoreDice([1]), 100);
  assert.equal(scoreDice([5]), 50);
  assert.equal(scoreDice([1, 5]), 150);
  assert.equal(scoreDice([1, 1]), 200);
  assert.equal(scoreDice([2]), 0);
  assert.equal(scoreDice([1, 2]), 0, 'a dead die invalidates the selection');
});

test('three, four, five, six of a kind', () => {
  assert.equal(scoreDice([2, 2, 2]), 200);
  assert.equal(scoreDice([3, 3, 3]), 300);
  assert.equal(scoreDice([6, 6, 6]), 600);
  assert.equal(scoreDice([1, 1, 1]), 1000);
  assert.equal(scoreDice([5, 5, 5]), 500);
  assert.equal(scoreDice([2, 2, 2, 2]), 1000);
  assert.equal(scoreDice([4, 4, 4, 4, 4]), 2000);
  assert.equal(scoreDice([6, 6, 6, 6, 6, 6]), 3000);
  assert.equal(scoreDice([2, 2, 2, 1]), 300);
  assert.equal(scoreDice([1, 1, 1, 1]), 1100, 'triple + single beats four of a kind');
  assert.equal(scoreDice([3, 3, 3, 3]), 1000);
});

test('six-dice combinations', () => {
  assert.equal(scoreDice([1, 2, 3, 4, 5, 6]), 1500);
  assert.equal(scoreDice([2, 2, 3, 3, 4, 4]), 1500);
  assert.equal(scoreDice([2, 2, 2, 6, 6, 6]), 2500);
  assert.equal(scoreDice([3, 3, 3, 3, 4, 4]), 1500);
  assert.equal(scoreDice([1, 1, 1, 5, 5, 5]), 2500);
  assert.equal(scoreDice([2, 3, 4, 6, 6, 2]), 0);
});

test('farkle detection and usable dice', () => {
  assert.equal(hasScoring([2, 3, 4, 6, 6, 2]), false);
  assert.equal(hasScoring([2, 3, 4, 6, 6, 1]), true);
  assert.equal(hasScoring([2, 2, 3, 3, 4, 4]), true);
  assert.deepEqual(usableDice([1, 2, 2, 2, 3, 6]), [true, true, true, true, false, false]);
});

function game(opts) { return newGameState([0, 1], opts); }

test('farkle loses the turn total and passes the turn', () => {
  const g = game();
  applyRoll(g, seq(2, 3, 4, 6, 6, 2));
  assert.equal(g.phase, 'farkle');
  applyPass(g);
  assert.equal(g.turn, 1);
  assert.equal(g.phase, 'roll');
  assert.equal(g.scores[0], 0);
});

test('entry score is needed before banking', () => {
  const g = game();
  applyRoll(g, seq(1, 2, 3, 3, 4, 6));
  assert.match(checkKeep(g, [0], true).error, /500/);
  assert.throws(() => applyKeep(g, [0], true, seq(1)));
  applyKeep(g, [0], false, seq(1, 1, 1, 2, 3)); // keep the 1, roll five dice: 1,1,1,2,3
  assert.equal(g.turnScore, 100);
  applyKeep(g, [1, 2, 3], true, seq(1)); // three 1s = 1000
  assert.equal(g.scores[0], 1100);
  assert.equal(g.onBoard[0], true);
  assert.equal(g.turn, 1);
});

test('invalid selections are rejected', () => {
  const g = game();
  applyRoll(g, seq(1, 2, 3, 3, 4, 6));
  assert.ok(checkKeep(g, [0, 1], false).error); // the 2 does not score
  assert.ok(checkKeep(g, [0, 0], false).error); // duplicate
  assert.ok(checkKeep(g, [9], false).error); // out of range
  assert.ok(checkKeep(g, [], false).error);
});

test('hot dice: keeping all six rolls six fresh dice', () => {
  const g = game();
  applyRoll(g, seq(1, 2, 3, 4, 5, 6)); // straight
  applyKeep(g, [0, 1, 2, 3, 4, 5], false, seq(5, 5, 2, 3, 4, 6));
  assert.equal(g.turnScore, 1500);
  assert.equal(g.last.hot, true);
  assert.equal(g.slots.filter((s) => s.kept).length, 0);
  assert.equal(g.phase, 'select');
});

test('rolling after keeping only rolls the remaining dice', () => {
  const g = game();
  applyRoll(g, seq(1, 5, 2, 3, 4, 6));
  applyKeep(g, [0], false, seq(6, 6, 6, 6, 6));
  assert.deepEqual(g.slots.map((s) => s.kept), [true, false, false, false, false, false]);
  assert.equal(g.slots[0].v, 1);
});

test('reaching the target triggers one last turn for everyone else', () => {
  const g = newGameState([0, 1, 2], { target: 1000, entry: 500 });
  applyRoll(g, seq(1, 1, 1, 2, 3, 4));
  applyKeep(g, [0, 1, 2], true, seq(1)); // 1000 -> triggers
  assert.deepEqual(g.final, { trigger: 0, pending: [1, 2] });
  assert.equal(g.turn, 1);
  applyRoll(g, seq(2, 3, 4, 6, 6, 2)); applyPass(g); // seat 1 farkles
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 2);
  applyRoll(g, seq(5, 5, 5, 2, 3, 4)); applyKeep(g, [0, 1, 2], true, seq(1)); // 500, on board
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 0);
});

test('a rival can overtake in the final round', () => {
  const g = newGameState([0, 1], { target: 1000, entry: 500 });
  applyRoll(g, seq(1, 1, 1, 2, 3, 4)); applyKeep(g, [0, 1, 2], true, seq(1)); // seat 0: 1000
  applyRoll(g, seq(1, 2, 3, 4, 5, 6)); applyKeep(g, [0, 1, 2, 3, 4, 5], false, seq(2, 2, 2, 2, 2, 2)); // 1500 + 3000? hot dice roll 2s
  assert.equal(g.phase, 'select');
  applyKeep(g, [0, 1, 2, 3, 4, 5], true, seq(1)); // 1500 + 3000
  assert.equal(g.scores[1], 4500);
  assert.equal(g.phase, 'over');
  assert.equal(g.winner, 1);
});

test('bot plays legal actions to the end of a game', () => {
  const g = newGameState([0, 1, 2], { target: 2000 });
  const rng = () => 1 + Math.floor(Math.random() * 6);
  for (let step = 0; step < 5000 && g.phase !== 'over'; step++) {
    if (g.phase === 'roll') applyRoll(g, rng);
    else if (g.phase === 'farkle') applyPass(g);
    else {
      const { keep, bank } = chooseBotAction(g);
      applyKeep(g, keep, bank, rng);
    }
  }
  assert.equal(g.phase, 'over');
  assert.ok(g.scores[g.winner] >= 2000);
});

test('classic scoring: four/five/six of a kind are 2x/3x/4x the triple', () => {
  const s = (v) => scoreDice(v, 'classic');
  assert.equal(s([3, 3, 3]), 300);
  assert.equal(s([3, 3, 3, 3]), 600);
  assert.equal(s([3, 3, 3, 3, 3]), 900);
  assert.equal(s([3, 3, 3, 3, 3, 3]), 1200);
  assert.equal(s([1, 1, 1]), 1000);
  assert.equal(s([1, 1, 1, 1]), 2000);
  assert.equal(s([1, 1, 1, 1, 1]), 3000);
  assert.equal(s([1, 1, 1, 1, 1, 1]), 4000);
  assert.equal(s([5, 5, 5, 5]), 1000);
  assert.equal(s([1, 2, 3, 4, 5, 6]), 1500);
  assert.equal(s([2, 2, 2, 6, 6, 6]), 2500);
});

test('Farkle 2.0 scoring: three 1s = 300, fixed four/five/six of a kind', () => {
  const s = (v) => scoreDice(v, 'v2');
  assert.equal(s([1, 1, 1]), 300);
  assert.equal(s([1, 1, 1, 1]), 1000);
  assert.equal(s([1, 1, 1, 1, 1]), 2000);
  assert.equal(s([1, 1, 1, 1, 1, 1]), 3000);
  assert.equal(s([4, 4, 4]), 400);
  assert.equal(s([4, 4, 4, 4]), 1000);
  assert.equal(s([2, 2, 2, 1]), 300);
});

test('hybrid is the default and games remember their scoring mode', () => {
  assert.equal(scoreDice([1, 1, 1]), 1000);
  assert.equal(newGameState([0, 1]).scoring, 'hybrid');
  assert.equal(newGameState([0, 1], { scoring: 'classic' }).scoring, 'classic');
  assert.equal(newGameState([0, 1], { scoring: 'bogus' }).scoring, 'hybrid');
  const g = newGameState([0, 1], { scoring: 'v2' });
  applyRoll(g, seq(1, 1, 1, 2, 3, 4));
  assert.equal(checkKeep(g, [0, 1, 2], false).score, 300);
});

test('entry minimum can be turned off', () => {
  const g = newGameState([0, 1], { entry: 0 });
  applyRoll(g, seq(1, 2, 3, 3, 4, 6));
  assert.equal(checkKeep(g, [0], true).score, 100);
  applyKeep(g, [0], true, seq(1));
  assert.equal(g.scores[0], 100);
  assert.equal(g.onBoard[0], true);
  // bots bank freely too, so a whole game still finishes
  const bots = newGameState([0, 1], { target: 1000, entry: 0 });
  const rng = () => 1 + Math.floor(Math.random() * 6);
  for (let i = 0; i < 5000 && bots.phase !== 'over'; i++) {
    if (bots.phase === 'roll') applyRoll(bots, rng);
    else if (bots.phase === 'farkle') applyPass(bots);
    else { const { keep, bank } = chooseBotAction(bots); applyKeep(bots, keep, bank, rng); }
  }
  assert.equal(bots.phase, 'over');
});

test('history records every turn with the running total, or a farkle', () => {
  const g = newGameState([0, 1], { entry: 0 });
  applyRoll(g, seq(1, 1, 1, 2, 3, 4)); applyKeep(g, [0, 1, 2], true, seq(1)); // seat 0 banks 1000
  applyRoll(g, seq(2, 3, 4, 6, 6, 2)); applyPass(g); // seat 1 farkles
  applyRoll(g, seq(5, 2, 3, 4, 6, 6)); applyKeep(g, [0], true, seq(1)); // round 2: seat 0 banks 50
  assert.deepEqual(g.history, [
    { r: 1, s: 0, f: false, t: 1000 },
    { r: 1, s: 1, f: true, t: 0 },
    { r: 2, s: 0, f: false, t: 1050 },
  ]);
});

test('player colors are unique and include classic white', async () => {
  const { COLORS } = await import('../shared/config.js');
  assert.equal(new Set(COLORS.map((c) => c.hex)).size, COLORS.length);
  assert.equal(new Set(COLORS.map((c) => c.name)).size, COLORS.length);
  assert.ok(COLORS.some((c) => c.name === 'White'));
  assert.ok(COLORS.length >= 6, 'enough colors for every seat');
});

// ------------------------------------------------------------ High Stakes --
const hs = (opts = {}) => newGameState([0, 1, 2], { mode: 'highstakes', entry: 0, ...opts });
// Put every seat on the board with a quick 50-point bank (a lone 5). The last
// entry switches High Stakes on and so offers its leftover dice to seat 0; decline
// that so the next turn starts clean.
function everyoneOnBoard(g) {
  for (let i = 0; i < g.order.length; i++) {
    applyRoll(g, seq(5, 2, 3, 4, 6, 6));
    applyKeep(g, [0], true, seq(1));
  }
  assert.equal(g.phase, 'offer');
  applyOffer(g, false, seq(1));
}

test('high stakes does not start until everyone is on the board', () => {
  const g = hs();
  applyRoll(g, seq(5, 2, 3, 4, 6, 6)); applyKeep(g, [0], true, seq(1)); // seat 0 banks, others not yet on board
  assert.equal(g.phase, 'roll');
  assert.equal(g.offer, null);
  applyRoll(g, seq(5, 2, 3, 4, 6, 6)); applyKeep(g, [0], true, seq(1)); // seat 1
  assert.equal(g.phase, 'roll');
  applyRoll(g, seq(5, 2, 3, 4, 6, 6)); applyKeep(g, [0], true, seq(1)); // seat 2: now everyone is on the board
  assert.equal(g.phase, 'offer', 'high stakes is live from the moment the last player gets on the board');
  assert.equal(g.offer.stake, 50);
  assert.equal(g.offer.dice, 5);
  assert.equal(g.turn, 0);
});

test('standard mode never makes an offer', () => {
  const g = newGameState([0, 1], { entry: 0 });
  applyRoll(g, seq(5, 2, 3, 4, 6, 6)); applyKeep(g, [0], true, seq(1));
  applyRoll(g, seq(5, 2, 3, 4, 6, 6)); applyKeep(g, [0], true, seq(1));
  applyRoll(g, seq(5, 2, 3, 4, 6, 6)); applyKeep(g, [0], true, seq(1));
  assert.equal(g.phase, 'roll');
  assert.equal(g.offer, null);
});

test('after a bank the next player is offered the dice left behind', () => {
  const g = hs();
  everyoneOnBoard(g);
  // seat 0 keeps three 1s (1000) out of six, banks: 3 dice are left
  applyRoll(g, seq(1, 1, 1, 2, 3, 4));
  applyKeep(g, [0, 1, 2], true, seq(1));
  assert.equal(g.phase, 'offer');
  assert.equal(g.turn, 1);
  assert.equal(g.offer.stake, 1000);
  assert.equal(g.offer.dice, 3);
  assert.equal(g.offer.from, 0);
  assert.equal(g.slots.filter((s) => s.kept).length, 3, 'the dice seat 0 kept stay on the table');
  assert.equal(g.scores[0], 1050);
});

test('taking the offer and scoring adds the stake to your roll', () => {
  const g = hs();
  everyoneOnBoard(g);
  applyRoll(g, seq(1, 1, 1, 2, 3, 4)); applyKeep(g, [0, 1, 2], true, seq(1)); // stake 1000, 3 dice left
  applyOffer(g, true, seq(5, 2, 3)); // seat 1 rolls 5,2,3 -> a 5 scores
  assert.equal(g.phase, 'select');
  assert.equal(g.turnScore, 1000);
  assert.equal(g.last.highStakes, true);
  const free = g.slots.map((s, i) => (s.kept ? -1 : i)).filter((i) => i !== -1);
  assert.equal(free.length, 3, 'only the three leftover dice are rolled');
  const fiveAt = free.find((i) => g.slots[i].v === 5);
  applyKeep(g, [fiveAt], true, seq(1));
  assert.equal(g.scores[1], 50 + 1000 + 50, 'previous 50, plus the stake, plus the 5');
  assert.equal(g.turn, 2);
});

test('rolling nothing on a high stakes roll is a farkle and loses only the turn', () => {
  const g = hs();
  everyoneOnBoard(g);
  applyRoll(g, seq(1, 1, 1, 2, 3, 4)); applyKeep(g, [0, 1, 2], true, seq(1));
  const before = g.scores[1];
  applyOffer(g, true, seq(2, 3, 4));
  assert.equal(g.phase, 'farkle');
  assert.equal(g.last.lost, 0);
  applyPass(g);
  assert.equal(g.scores[1], before);
  assert.equal(g.scores[0], 1050, 'the first player keeps what they banked');
  assert.equal(g.turn, 2);
  assert.equal(g.phase, 'roll', 'no offer follows a farkle');
});

test('declining plays a normal turn with all six dice', () => {
  const g = hs();
  everyoneOnBoard(g);
  applyRoll(g, seq(1, 1, 1, 2, 3, 4)); applyKeep(g, [0, 1, 2], true, seq(1));
  applyOffer(g, false, seq(1));
  assert.equal(g.phase, 'roll');
  assert.equal(g.turn, 1);
  assert.equal(g.turnScore, 0);
  assert.equal(g.slots.filter((s) => s.kept).length, 0);
  assert.equal(g.offer, null);
});

test('banking after hot dice offers all six dice', () => {
  const g = hs();
  everyoneOnBoard(g);
  applyRoll(g, seq(1, 2, 3, 4, 5, 6)); // straight: all six dice score
  applyKeep(g, [0, 1, 2, 3, 4, 5], true, seq(1));
  assert.equal(g.phase, 'offer');
  assert.equal(g.offer.stake, 1500);
  assert.equal(g.offer.dice, 6);
  assert.equal(g.slots.filter((s) => s.kept).length, 0);
});

test('stakes chain: the next offer includes the carried points', () => {
  const g = hs();
  everyoneOnBoard(g);
  applyRoll(g, seq(1, 1, 1, 2, 3, 4)); applyKeep(g, [0, 1, 2], true, seq(1)); // stake 1000
  applyOffer(g, true, seq(5, 5, 3)); // seat 1 rolls two 5s
  const free = g.slots.map((s, i) => (s.kept ? -1 : i)).filter((i) => i !== -1);
  const fives = free.filter((i) => g.slots[i].v === 5);
  applyKeep(g, fives, true, seq(1)); // banks 1000 + 100 = 1100, one die left
  assert.equal(g.phase, 'offer');
  assert.equal(g.turn, 2);
  assert.equal(g.offer.stake, 1100);
  assert.equal(g.offer.dice, 1);
});

test('you can keep rolling after a successful high stakes roll', () => {
  const g = hs();
  everyoneOnBoard(g);
  applyRoll(g, seq(1, 1, 1, 2, 3, 4)); applyKeep(g, [0, 1, 2], true, seq(1)); // 3 dice left
  applyOffer(g, true, seq(5, 5, 5)); // three 5s = 500
  const free = g.slots.map((s, i) => (s.kept ? -1 : i)).filter((i) => i !== -1);
  applyKeep(g, free, false, seq(1, 2, 3, 4, 6, 6)); // all six dice are now set aside: hot dice, roll six
  assert.equal(g.phase, 'select');
  assert.equal(g.turnScore, 1500);
  assert.equal(g.last.hot, true);
});

test('wrong-phase and bad calls are rejected', () => {
  const g = hs();
  assert.throws(() => applyOffer(g, true, seq(1)));
});

test('bots accept big stakes with many dice and decline small stakes with few dice', () => {
  const g = hs();
  g.offer = { stake: 1000, dice: 3, from: 0, slots: [] };
  assert.equal(chooseBotOffer(g), true);
  g.offer = { stake: 100, dice: 1, from: 0, slots: [] };
  assert.equal(chooseBotOffer(g), false);
  g.offer = { stake: 300, dice: 6, from: 0, slots: [] };
  assert.equal(chooseBotOffer(g), true);
});

test('a whole high stakes game with bots always finishes', () => {
  for (let n = 0; n < 40; n++) {
    const g = newGameState([0, 1, 2, 3], { mode: 'highstakes', entry: n % 2 ? 500 : 0, target: 3000 });
    const rng = () => 1 + Math.floor(Math.random() * 6);
    for (let step = 0; step < 20000 && g.phase !== 'over'; step++) {
      if (g.phase === 'roll') applyRoll(g, rng);
      else if (g.phase === 'farkle') applyPass(g);
      else if (g.phase === 'offer') applyOffer(g, chooseBotOffer(g), rng);
      else { const { keep, bank } = chooseBotAction(g); applyKeep(g, keep, bank, rng); }
    }
    assert.equal(g.phase, 'over', `game ${n} did not finish`);
  }
});
