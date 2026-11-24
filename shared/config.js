// Constants shared by the server (rules) and the client (rendering).
export const MAX_SEATS = 6;
export const DICE = 6;
export const TARGETS = [5000, 10000];
export const DEFAULT_TARGET = 10000;
export const ENTRY_SCORE = 500; // minimum turn total needed to "get on the board"

export const SEAT_COLORS = [
  { name: 'Crimson', hex: '#e0443a' },
  { name: 'Azure', hex: '#3d8ee6' },
  { name: 'Emerald', hex: '#33b46a' },
  { name: 'Amber', hex: '#e8a928' },
  { name: 'Violet', hex: '#9a5fd6' },
  { name: 'Teal', hex: '#27b5b0' },
];

// Scoring rule sets. Everything except three/four/five/six of a kind is shared:
// single 1 = 100, single 5 = 50, straight 1-6 / three pairs / four + pair = 1500,
// two triplets = 2500. `triple1` is the score for three 1s; three 2s-6s is face x 100.
// `kind` says how four/five/six of a kind score.
const SHARED_ROWS = [
  ['Single 1', '100'], ['Single 5', '50'], ['Straight 1–6', '1,500'], ['Three pairs', '1,500'],
  ['Four of a kind + pair', '1,500'], ['Two triplets', '2,500'],
];
export const SCORING = {
  hybrid: {
    name: 'Hybrid',
    blurb: 'Three 1s = 1,000; four / five / six of a kind = 1,000 / 2,000 / 3,000.',
    triple1: 1000,
    kind: { 4: 1000, 5: 2000, 6: 3000 },
    rows: [['Three 1s', '1,000'], ['Three 2s–6s', '200–600'], ['Four of a kind', '1,000'], ['Five of a kind', '2,000'], ['Six of a kind', '3,000'], ...SHARED_ROWS],
  },
  classic: {
    name: 'Classic',
    blurb: 'Three 1s = 1,000; four / five / six of a kind = 2x / 3x / 4x the triple.',
    triple1: 1000,
    kindMultiple: { 4: 2, 5: 3, 6: 4 },
    rows: [['Three 1s', '1,000'], ['Three 2s–6s', '200–600'], ['Four of a kind', '2x the triple'], ['Five of a kind', '3x the triple'], ['Six of a kind', '4x the triple'], ...SHARED_ROWS],
  },
  v2: {
    name: 'Farkle 2.0',
    blurb: 'Three 1s = 300; four / five / six of a kind = 1,000 / 2,000 / 3,000.',
    triple1: 300,
    kind: { 4: 1000, 5: 2000, 6: 3000 },
    rows: [['Three 1s', '300'], ['Three 2s–6s', '200–600'], ['Four of a kind', '1,000'], ['Five of a kind', '2,000'], ['Six of a kind', '3,000'], ...SHARED_ROWS],
  },
};
export const SCORING_MODES = Object.keys(SCORING);
export const DEFAULT_SCORING = 'hybrid';
