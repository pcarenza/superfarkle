import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreDice, hasScoring, usableDice, newGameState, applyRoll, applyKeep, applyPass, checkKeep, chooseBotAction } from '../shared/rules.js';

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
