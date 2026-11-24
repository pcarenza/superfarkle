// Tiny synthesized sound effects (no audio files needed).
let ctx = null;
let muted = false;
try { muted = localStorage.getItem('muted') === '1'; } catch {}

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// A short burst of filtered noise: the click of a die on felt/wood.
function knock(gain = 0.5, freq = 1400, decay = 0.045, when = 0) {
  const a = !muted && ac();
  if (!a) return;
  const t = a.currentTime + when;
  const len = Math.floor(a.sampleRate * decay * 2);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (a.sampleRate * decay * 0.25));
  const src = a.createBufferSource();
  src.buffer = buf;
  const bp = a.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 2.5;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + decay * 2);
  src.connect(bp).connect(g).connect(a.destination);
  src.start(t);
}

function tone(freq, dur = 0.25, type = 'sine', gain = 0.2, when = 0, slideTo = null) {
  const a = !muted && ac();
  if (!a) return;
  const t = a.currentTime + when;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  get muted() { return muted; },
  set muted(v) { muted = !!v; try { localStorage.setItem('muted', v ? '1' : '0'); } catch {} },
  unlock() { ac(); },
  // Dice rattling across the table.
  rattle() {
    for (let i = 0; i < 9; i++) knock(0.35 + Math.random() * 0.3, 900 + Math.random() * 1800, 0.03 + Math.random() * 0.03, i * 0.075 + Math.random() * 0.04);
    knock(0.7, 700, 0.07, 0.8);
  },
  select() { knock(0.45, 2200, 0.03); },
  bank() { [880, 1108, 1318].forEach((f, i) => tone(f, 0.35, 'triangle', 0.16, i * 0.08)); },
  farkle() { tone(220, 0.55, 'sawtooth', 0.14, 0, 90); tone(165, 0.6, 'square', 0.07, 0.05, 70); },
  hot() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'triangle', 0.14, i * 0.06)); },
  chime() { [523, 659, 784, 1047, 1318].forEach((f, i) => tone(f, 0.6, 'sine', 0.16, i * 0.12)); },
  pop() { tone(700, 0.08, 'sine', 0.12, 0, 1100); },
};
