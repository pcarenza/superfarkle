// Farkle rules engine. Pure functions over a JSON-serialisable game state, so
// the server can broadcast it as-is and the client can reuse the scoring.
import { DICE, MAX_SEATS, ENTRY_SCORE, DEFAULT_TARGET, SCORING, DEFAULT_SCORING } from './config.js';

// ---------------------------------------------------------------- scoring --
// 1 = 100, 5 = 50. Three of a kind = face x 100, with three 1s and four-or-more
// of a kind depending on the rule set (see SCORING in config.js).
// Six dice only: 1-2-3-4-5-6 = 1500, three pairs = 1500,
// four of a kind + a pair = 1500, two triplets = 2500.

function counts(values) {
  const c = [0, 0, 0, 0, 0, 0, 0];
  for (const v of values) c[v]++;
  return c;
}

const single = (face) => (face === 1 ? 100 : face === 5 ? 50 : 0);
const ruleSet = (mode) => SCORING[mode] ?? SCORING[DEFAULT_SCORING];
const triple = (face, rs) => (face === 1 ? rs.triple1 : face * 100);
const ofAKind = (face, n, rs) => (n === 3 ? triple(face, rs) : rs.kindMultiple ? triple(face, rs) * rs.kindMultiple[n] : rs.kind[n]);

// Score of a set of dice in which EVERY die must contribute; 0 if one doesn't.
function plainScore(c, rs) {
  let total = 0;
  for (let f = 1; f <= 6; f++) {
    const n = c[f];
    if (!n) continue;
    let best = -1;
    if (n < 3) {
      if (single(f)) best = n * single(f);
    } else {
      best = ofAKind(f, n, rs);
      if (single(f)) best = Math.max(best, triple(f, rs) + (n - 3) * single(f));
    }
    if (best < 0) return 0;
    total += best;
  }
  return total;
}

/** Points for exactly these dice, or 0 if empty or any die is dead weight. */
export function scoreDice(values, mode = DEFAULT_SCORING) {
  if (!values.length) return 0;
  const rs = ruleSet(mode);
  const c = counts(values);
  let best = 0;
  if (values.length === 6) {
    const nz = c.slice(1).filter(Boolean).sort();
    if (nz.length === 6) best = 1500; // straight
    else if (nz.length === 3 && nz.every((n) => n === 2)) best = 1500; // three pairs
    else if (nz.length === 2 && nz[0] === 3 && nz[1] === 3) best = 2500; // two triplets
    else if (nz.length === 2 && nz[0] === 2 && nz[1] === 4) best = 1500; // four + pair
  }
  return Math.max(best, plainScore(c, rs));
}

/** Every non-empty subset of `values` (as index lists) that scores, with its score. */
export function scoringSubsets(values, mode = DEFAULT_SCORING) {
  const out = [];
  const n = values.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const idx = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) idx.push(i);
    const score = scoreDice(idx.map((i) => values[i]), mode);
    if (score) out.push({ idx, score });
  }
  return out;
}

export const hasScoring = (values, mode = DEFAULT_SCORING) => scoringSubsets(values, mode).length > 0;

/** Which of these dice can be part of some scoring selection (for hints). */
export function usableDice(values, mode = DEFAULT_SCORING) {
  const ok = values.map(() => false);
  for (const { idx } of scoringSubsets(values, mode)) for (const i of idx) ok[i] = true;
  return ok;
}

// ------------------------------------------------------------------ state --
/**
 * @param {number[]} order seat numbers in turn order
 * @param {{target?: number, entry?: number, scoring?: string}} opts
 */
export function newGameState(order, opts = {}) {
  return {
    order: [...order],
    turn: order[0],
    phase: 'roll', // roll | select | farkle | over
    target: opts.target ?? DEFAULT_TARGET,
    entry: opts.entry ?? ENTRY_SCORE,
    scoring: SCORING[opts.scoring] ? opts.scoring : DEFAULT_SCORING,
    scores: Array(MAX_SEATS).fill(0),
    onBoard: Array(MAX_SEATS).fill(false),
    slots: freshSlots(),
    turnScore: 0, // points locked in so far this turn
    rollId: 0,
    seq: 0, // bumps on every state change; lets clients detect missed updates
    round: 1,
    final: null, // {trigger, pending: seats still owed a last turn}
    winner: null,
    last: null,
  };
}

const freshSlots = () => Array.from({ length: DICE }, () => ({ v: 0, kept: false }));
const freeIdx = (g) => g.slots.map((s, i) => (s.kept ? -1 : i)).filter((i) => i !== -1);

/** Roll every die that has not been set aside. `rollDie` returns 1..6. */
export function applyRoll(g, rollDie, extra = {}) {
  if (g.phase !== 'roll') throw new Error('not in roll phase');
  const free = freeIdx(g);
  for (const i of free) g.slots[i].v = rollDie();
  g.rollId++;
  g.seq++;
  const seat = g.turn;
  if (hasScoring(free.map((i) => g.slots[i].v), g.scoring)) {
    g.phase = 'select';
    g.last = { type: 'roll', seat, rollId: g.rollId, ...extra };
  } else {
    g.phase = 'farkle';
    g.last = { type: 'farkle', seat, rollId: g.rollId, lost: g.turnScore, ...extra };
  }
  return g;
}

/** Check a selection of free dice. Returns {score} or {error}. */
export function checkKeep(g, indices, bank) {
  if (g.phase !== 'select') return { error: 'Nothing to keep right now.' };
  if (!Array.isArray(indices) || !indices.length) return { error: 'Pick at least one scoring die.' };
  const free = new Set(freeIdx(g));
  const uniq = new Set(indices);
  if (uniq.size !== indices.length || indices.some((i) => !Number.isInteger(i) || !free.has(i))) return { error: 'Illegal selection.' };
  const score = scoreDice(indices.map((i) => g.slots[i].v), g.scoring);
  if (!score) return { error: 'Every die you keep must score.' };
  if (bank && !g.onBoard[g.turn] && g.turnScore + score < g.entry) {
    return { error: `You need ${g.entry} in one turn to get on the board.` };
  }
  return { score };
}

/**
 * Keep the selected dice, then either bank the turn total or roll the rest.
 * Keeping all six dice is "hot dice": you roll all six again.
 */
export function applyKeep(g, indices, bank, rollDie) {
  const chk = checkKeep(g, indices, bank);
  if (chk.error) throw new Error(chk.error);
  const seat = g.turn;
  for (const i of indices) g.slots[i].kept = true;
  g.turnScore += chk.score;
  if (bank) {
    const points = g.turnScore;
    g.scores[seat] += points;
    g.onBoard[seat] = true;
    g.seq++;
    g.last = { type: 'bank', seat, points, gained: chk.score };
    endTurn(g, true);
    return g;
  }
  const hot = g.slots.every((s) => s.kept);
  if (hot) g.slots = freshSlots();
  g.phase = 'roll';
  return applyRoll(g, rollDie, { gained: chk.score, hot });
}

/** After a farkle has been shown, the turn passes and the turn total is lost. */
export function applyPass(g) {
  if (g.phase !== 'farkle') throw new Error('not a farkle');
  const seat = g.turn;
  g.seq++;
  endTurn(g, false);
  g.last = { type: 'pass', seat };
  return g;
}

function endTurn(g, banked) {
  const seat = g.turn;
  if (banked && !g.final && g.scores[seat] >= g.target) {
    g.final = { trigger: seat, pending: g.order.filter((s) => s !== seat) };
  } else if (g.final) {
    g.final.pending = g.final.pending.filter((s) => s !== seat);
  }
  g.turnScore = 0;
  g.slots = freshSlots();
  if (g.final && g.final.pending.length === 0) {
    g.phase = 'over';
    g.winner = g.order.reduce((best, s) => (g.scores[s] > g.scores[best] ? s : best), g.order[0]);
    return;
  }
  const at = g.order.indexOf(seat);
  const next = (at + 1) % g.order.length;
  if (next === 0) g.round++;
  g.turn = g.order[next];
  g.phase = 'roll';
}

// -------------------------------------------------------------------- bot --
// Rough value of having n dice left to roll again.
const DICE_VALUE = [0, 10, 25, 60, 110, 200, 330];
// Bank once the turn total reaches this, by number of dice that would be rolled.
const BANK_AT = [0, 300, 300, 400, 600, 1500, 99999];

/** Decide what a computer player keeps and whether it banks. */
export function chooseBotAction(g) {
  const free = freeIdx(g);
  const subsets = scoringSubsets(free.map((i) => g.slots[i].v), g.scoring);
  let best = null;
  for (const s of subsets) {
    const left = free.length - s.idx.length;
    const dl = left === 0 ? 6 : left;
    const value = s.score + DICE_VALUE[dl];
    if (!best || value > best.value) best = { ...s, dl, value };
  }
  const keep = best.idx.map((i) => free[i]);
  const total = g.turnScore + best.score;
  const seat = g.turn;
  const mustRoll = !g.onBoard[seat] && total < g.entry;
  let bank;
  if (mustRoll) bank = false;
  else if (g.scores[seat] + total >= g.target) bank = true;
  else if (g.final) {
    const rival = Math.max(...g.order.filter((s) => s !== seat).map((s) => g.scores[s]));
    bank = g.scores[seat] + total > rival;
  } else bank = best.dl < 6 && total >= BANK_AT[best.dl];
  return { keep, bank };
}
