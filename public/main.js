import { DiceView } from './scene.js';
import { SEAT_COLORS, ENTRY_SCORE, TARGETS, SCORING, SCORING_MODES, DEFAULT_SCORING } from '/shared/config.js';
import { scoreDice, usableDice } from '/shared/rules.js';
import { sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const view = new DiceView($('stage'));
// The token is read on every (re)connect: a first-time visitor only receives
// theirs after connecting, and must send it back if the connection drops.
// In the Android app the page is served locally and FARKLE_SERVER names the
// hosted game server; on the website it is unset and we use our own origin.
const SERVER = window.FARKLE_SERVER || '';
const SITE = SERVER || `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`.replace(/\/$/, '');
const socketOpts = { auth: (cb) => cb({ token: store.get('token') }) };
// The app connects cross-origin: start with a WebSocket (not subject to CORS)
// and only fall back to long-polling, which needs the server's CORS setting.
if (SERVER) socketOpts.transports = ['websocket', 'polling'];
const socket = SERVER ? io(SERVER, socketOpts) : io(socketOpts);

// Native extras when running inside the Android app (no-ops on the web).
const native = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins : null;
const buzz = (style = 'MEDIUM') => { try { native?.Haptics?.impact({ style }); } catch {} };
const keepAwake = (on) => { try { on ? native?.KeepAwake?.keepAwake() : native?.KeepAwake?.allowSleep(); } catch {} };
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { __view: view, __socket: socket }); // for automated tests
socket.on('token', (t) => store.set('token', t));

let room = null; // latest room state from the server
let shown = null; // the game state currently drawn
let gameoverDismissed = false;
const queue = [];
let busy = false;
let wantRoom = false; // true while we are (trying to be) in a room
let inRoomScreen = false;
let animating = false;
let sel = new Set(); // slots the player has tapped
let pending = false; // a keep/roll request is in flight

// --------------------------------------------------------------- screens --
function screen(name) {
  $('welcome').hidden = name !== 'welcome';
  $('lobby').hidden = name !== 'lobby';
  $('hud').hidden = name !== 'game';
  $('toolbar').hidden = name === 'welcome';
  for (const b of document.querySelectorAll('#toolbar .game-only')) b.hidden = name !== 'game';
  inRoomScreen = name !== 'welcome';
  if (name !== 'game') hideSizePop();
  keepAwake(name === 'game');
  layoutChat();
  fitTable();
}

$('name').value = store.get('name') || '';
const urlCode = new URLSearchParams(location.search).get('room');
if (urlCode) $('code').value = urlCode.toUpperCase();
screen('welcome');

function emit(ev, data, errEl) {
  return new Promise((resolve) => {
    socket.emit(ev, data, (res) => {
      if (res?.error) {
        if (errEl) errEl.textContent = res.error;
        else toast(res.error, 'bad');
      } else if (errEl) errEl.textContent = '';
      resolve(res);
    });
  });
}

function myName() {
  const n = $('name').value.trim();
  if (n) store.set('name', n);
  return n;
}

$('create').onclick = async () => {
  sfx.unlock();
  if (!myName()) return ($('welcome-error').textContent = 'Please enter your name first.');
  wantRoom = true;
  const res = await emit('createRoom', { name: myName() }, $('welcome-error'));
  if (res?.ok) joined(res.code);
  else wantRoom = false;
};
async function join() {
  sfx.unlock();
  if (!myName()) return ($('welcome-error').textContent = 'Please enter your name first.');
  const code = $('code').value.trim().toUpperCase();
  if (code.length !== 4) return ($('welcome-error').textContent = 'Room codes are 4 letters.');
  wantRoom = true;
  const res = await emit('joinRoom', { code, name: myName() }, $('welcome-error'));
  if (res?.ok) joined(res.code);
  else wantRoom = false;
}
$('join').onclick = join;
$('code').addEventListener('keydown', (e) => e.key === 'Enter' && join());

function joined(code) {
  store.set('room', code);
  history.replaceState(null, '', `?room=${code}`);
}

function leave() {
  wantRoom = false;
  socket.emit('leave');
  store.set('room', null);
  history.replaceState(null, '', location.pathname);
  room = null;
  shown = null;
  queue.length = 0;
  sel = new Set();
  animating = false;
  view.set(blankSlots(), 0);
  view.setSelection(sel, null, false);
  $('gameover').hidden = true;
  clearChat();
  screen('welcome');
}
$('leave').onclick = leave;
$('btn-quit').onclick = () => { if (confirm('Leave this game? A computer player will take your seat.')) leave(); };

// Rejoin automatically after a refresh or a dropped connection.
socket.on('connect', () => {
  const code = store.get('room');
  const name = store.get('name');
  if (code && name && (!urlCode || urlCode.toUpperCase() === code)) {
    wantRoom = true;
    emit('joinRoom', { code, name }).then((res) => {
      if (!res?.ok) { wantRoom = false; store.set('room', null); screen('welcome'); }
    });
  }
});
socket.on('disconnect', () => { toast('Connection lost — reconnecting…', 'bad'); renderConnection(); });
// The free server sleeps when idle; the first connection can take up to a minute.
let connectFailures = 0;
function renderConnection() {
  const up = socket.connected;
  $('create').disabled = $('join').disabled = !up;
  $('conn').textContent = up ? ''
    : connectFailures > 12 ? "Can't reach the game server. Check your internet connection; still retrying…"
    : connectFailures ? 'Waking up the game server… this can take up to a minute.'
    : 'Connecting to the game server…';
}
socket.on('connect', () => { connectFailures = 0; renderConnection(); });
socket.on('connect_error', () => { connectFailures++; renderConnection(); });
renderConnection();

// ----------------------------------------------------------------- lobby --
$('copy-link').onclick = async () => {
  const url = `${SITE}/?room=${room.code}`;
  try { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
  catch { prompt('Share this link:', url); }
};
$('start').onclick = () => emit('start', null, $('lobby-error'));
$('again').onclick = () => emit('backToLobby');
$('gameover-close').onclick = () => { gameoverDismissed = true; $('gameover').hidden = true; };
for (const t of TARGETS) $('target').add(new Option(t.toLocaleString(), t));
$('target').onchange = () => emit('setOptions', { target: Number($('target').value) }, $('lobby-error'));
for (const m of SCORING_MODES) $('scoring').add(new Option(SCORING[m].name, m));
$('entry').onchange = () => emit('setOptions', { entry: $('entry').checked ? ENTRY_SCORE : 0 }, $('lobby-error'));
$('scoring').onchange = () => emit('setOptions', { scoring: $('scoring').value }, $('lobby-error'));

// The rules dialog shows the scoring table for the current game (or the default).
function renderRulesTable(mode) {
  const rs = SCORING[mode] ?? SCORING[DEFAULT_SCORING];
  $('rules-scoring-title').textContent = `Scoring: ${rs.name}`;
  const t = $('rules-table');
  t.replaceChildren();
  for (let i = 0; i < rs.rows.length; i += 2) {
    const tr = document.createElement('tr');
    for (const [a, b] of [rs.rows[i], rs.rows[i + 1] ?? ['', '']]) {
      const td1 = document.createElement('td'); td1.textContent = a;
      const td2 = document.createElement('td'); td2.textContent = b;
      tr.append(td1, td2);
    }
    t.append(tr);
  }
}
renderRulesTable(DEFAULT_SCORING);

function renderLobby() {
  const you = room.you;
  $('room-code').textContent = room.code;
  const ul = $('seats');
  ul.replaceChildren();
  room.seats.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="--c:${SEAT_COLORS[i].hex}"></span><span class="who"></span>`;
    const who = li.querySelector('.who');
    if (s) {
      who.textContent = s.name;
      if (s.bot) li.insertAdjacentHTML('beforeend', '<span class="tag">computer</span>');
      else if (!s.connected) li.insertAdjacentHTML('beforeend', '<span class="tag">away</span>');
      if (i === you.seat) {
        li.insertAdjacentHTML('beforeend', '<span class="tag">you</span>');
        li.append(btn('Stand up', () => emit('stand', null, $('lobby-error'))));
      } else if (you.isHost) {
        li.append(btn('Remove', () => emit('removeSeat', { seat: i }, $('lobby-error'))));
      }
    } else {
      who.textContent = `${SEAT_COLORS[i].name} — open`;
      who.classList.add('empty');
      li.append(btn(you.seat === -1 ? 'Sit here' : 'Move here', () => emit('sit', { seat: i }, $('lobby-error'))));
      if (you.isHost) li.append(btn('+ Computer', () => emit('addBot', { seat: i }, $('lobby-error'))));
    }
    ul.append(li);
  });
  $('target').value = room.options.target;
  $('scoring').value = room.options.scoring;
  $('entry').checked = room.options.entry > 0;
  $('target').disabled = $('scoring').disabled = $('entry').disabled = !you.isHost;
  $('scoring-blurb').textContent = SCORING[room.options.scoring].blurb;
  $('spectators').textContent = room.spectators.length ? `Watching: ${room.spectators.join(', ')}` : '';
  const seated = room.seats.filter(Boolean).length;
  $('start').hidden = !you.isHost;
  $('start').disabled = seated < 2;
  $('lobby-hint').textContent = you.isHost
    ? seated < 2 ? 'Share the code with friends, or add computer players. You need at least 2 players.' : ''
    : `Waiting for ${room.hostName ?? 'the host'} to start the game…`;
}

function btn(label, fn) {
  const b = document.createElement('button');
  b.className = 'small';
  b.textContent = label;
  b.onclick = fn;
  return b;
}

// ------------------------------------------------------------------ game --
const nameOf = (seat) => room?.seats[seat]?.name ?? SEAT_COLORS[seat].name;
const isMine = (seat) => room && room.you.seat === seat;
const label = (seat) => (isMine(seat) ? 'You' : nameOf(seat));
const blankSlots = () => Array.from({ length: 6 }, () => ({ v: 0, kept: false }));
const fmt = (n) => n.toLocaleString();

function renderPlayers(g) {
  const el = $('players');
  el.replaceChildren();
  const top = Math.max(...g.order.map((s) => g.scores[s]));
  for (const s of g.order) {
    const seat = room.seats[s];
    const div = document.createElement('div');
    div.className = 'pl' + (g.turn === s && g.phase !== 'over' ? ' turn' : '') + (seat && !seat.connected ? ' off' : '')
      + (top > 0 && g.scores[s] === top ? ' leader' : '');
    div.innerHTML = `<span class="dot" style="--c:${SEAT_COLORS[s].hex}"></span><span class="name"></span><span class="score">${fmt(g.scores[s])}</span>`;
    div.querySelector('.name').textContent = (isMine(s) ? '★ ' : '') + (seat?.name ?? '?') + (seat?.bot ? ' 🤖' : seat && !seat.connected ? ' (away)' : '');
    if (g.entry && !g.onBoard[s]) div.insertAdjacentHTML('beforeend', `<span class="off-board">needs ${g.entry}</span>`);
    el.append(div);
  }
}

function selScore(g) {
  return scoreDice([...sel].map((i) => g.slots[i].v), g.scoring);
}

function renderControls() {
  const g = shown;
  if (!g) return;
  const mine = isMine(g.turn);
  const canAct = mine && !animating && !pending;
  const score = g.phase === 'select' ? selScore(g) : 0;
  let msg;
  if (g.phase === 'over') msg = `${label(g.winner)} won!`;
  else if (g.phase === 'roll') msg = mine ? 'Your turn — roll the dice!' : `${nameOf(g.turn)} is rolling…`;
  else if (g.phase === 'select') msg = mine ? 'Tap the dice you want to keep' : `${nameOf(g.turn)} is choosing…`;
  else msg = `${label(g.turn)} farkled!`;
  if (g.final && g.phase !== 'over') msg += g.final.trigger === g.turn ? '' : ' · last turn!';
  $('status').textContent = msg;

  let tally = '';
  if (g.phase === 'select' && !animating) {
    if (mine) {
      const total = g.turnScore + score;
      tally = `This turn <b>${fmt(g.turnScore)}</b>${score ? ` + <span class="ok">${fmt(score)}</span> selected = <b>${fmt(total)}</b>` : ''}`;
      if (g.entry && !g.onBoard[g.turn] && total < g.entry) tally += `<br>You need ${fmt(g.entry)} to get on the board`;
    } else tally = `This turn <b>${fmt(g.turnScore)}</b>`;
  } else if (g.turnScore) tally = `This turn <b>${fmt(g.turnScore)}</b>`;
  $('tally').innerHTML = tally;

  $('roll').hidden = !(g.phase === 'roll' && mine);
  $('again-roll').hidden = $('bank').hidden = !(g.phase === 'select' && mine);
  $('roll').disabled = !canAct;
  $('again-roll').disabled = !canAct || !score;
  $('bank').disabled = !canAct || !score || (!g.onBoard[g.turn] && g.turnScore + score < g.entry);
  $('buttons').hidden = $('roll').hidden && $('again-roll').hidden;
  fitTable();
}

// Keep the dice clear of the HUD.
function fitTable() {
  const h = window.innerHeight;
  const playing = !$('hud').hidden;
  const narrow = window.matchMedia('(max-width: 720px)').matches;
  const top = playing ? (narrow ? $('players').getBoundingClientRect().bottom + 4 : 56) : 40;
  const bottom = playing ? h - $('controls').getBoundingClientRect().top + 4 : 0;
  view.setInsets(top, Math.max(0, bottom));
}
window.addEventListener('resize', fitTable);

function applySelection() {
  const g = shown;
  if (!g) return view.setSelection(sel, null, false);
  const free = g.slots.map((s, i) => (s.kept ? -1 : i)).filter((i) => i !== -1);
  let usable = null;
  if (g.phase === 'select' || g.phase === 'farkle') {
    usable = g.slots.map(() => true);
    const u = usableDice(free.map((i) => g.slots[i].v), g.scoring);
    free.forEach((slot, k) => (usable[slot] = u[k]));
  }
  view.setSelection(sel, usable, isMine(g.turn) && g.phase === 'select' && !animating && !pending);
}

view.onDieClick = (slot) => {
  const g = shown;
  if (!g || !isMine(g.turn) || g.phase !== 'select' || animating || pending) return;
  sfx.unlock();
  if (sel.has(slot)) sel.delete(slot); else sel.add(slot);
  sfx.select();
  applySelection();
  renderControls();
};

async function act(ev, data) {
  if (pending) return;
  sfx.unlock();
  pending = true;
  renderControls();
  const res = await emit(ev, data);
  if (res?.error) { pending = false; applySelection(); renderControls(); }
}
function roll() {
  const g = shown;
  if (g && isMine(g.turn) && g.phase === 'roll' && !animating) act('roll');
}
$('roll').onclick = roll;
$('again-roll').onclick = () => act('keep', { dice: [...sel], bank: false });
$('bank').onclick = () => act('keep', { dice: [...sel], bank: true });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); roll(); }
});

for (const b of document.querySelectorAll('[data-open]')) b.onclick = () => $(b.dataset.open).showModal();
const soundIcon = () => ($('btn-sound').textContent = sfx.muted ? '🔇' : '🔊');
soundIcon();
// Dice size is a per-device preference, remembered between visits.
const sizeInput = $('size');
const setSize = (pct, save = true) => {
  pct = Math.min(120, Math.max(50, Number(pct) || 100));
  sizeInput.value = pct;
  $('size-val').textContent = `${pct}%`;
  view.setZoom(pct / 100);
  if (save) store.set('diceSize', String(pct));
};
setSize(store.get('diceSize') || 100, false);
sizeInput.oninput = () => setSize(sizeInput.value);
$('size-reset').onclick = () => setSize(100);
$('btn-size').onclick = () => { const open = $('size-pop').hidden; hideSizePop(); $('size-pop').hidden = !open; };
// The popovers belong to the game screen; only one is open at a time.
function hideSizePop() { $('size-pop').hidden = true; $('tally-pop').hidden = true; }

// ----------------------------------------------------------- scoreboard --
const initialOf = (seat) => ([...(room?.seats[seat]?.name ?? '').trim()][0] ?? '?').toUpperCase();

// Turn-by-turn running scores: one row per round, one column per player.
// A cell holds the player's total after that turn, with a red F after it if they farkled.
function buildTally(g, final) {
  const t = document.createElement('table');
  t.className = `tally n${g.order.length}`;
  const head = t.createTHead().insertRow();
  head.insertCell().outerHTML = '<th class="rn">#</th>';
  for (const s of g.order) {
    const th = document.createElement('th');
    const b = document.createElement('span');
    b.className = 'badge';
    b.style.setProperty('--c', SEAT_COLORS[s].hex);
    b.textContent = initialOf(s);
    th.title = nameOf(s);
    th.append(b);
    head.append(th);
  }
  const rounds = new Map();
  for (const e of g.history) {
    if (!rounds.has(e.r)) rounds.set(e.r, new Map());
    rounds.get(e.r).set(e.s, e);
  }
  const body = t.createTBody();
  for (const [r, cells] of [...rounds].sort((a, b) => a[0] - b[0])) {
    const tr = body.insertRow();
    if (r === g.round && g.phase !== 'over') tr.className = 'now';
    tr.insertCell().outerHTML = `<td class="rn">${r}</td>`;
    for (const s of g.order) {
      const td = tr.insertCell();
      const e = cells.get(s);
      if (!e) continue;
      td.textContent = fmt(e.t);
      if (e.f) {
        const f = document.createElement('span');
        f.className = 'f';
        f.textContent = 'F';
        td.append(' ', f);
      }
    }
  }
  if (final) {
    const tr = t.createTFoot().insertRow();
    tr.className = 'total';
    tr.insertCell().outerHTML = '<td class="rn">Σ</td>';
    for (const s of g.order) tr.insertCell().textContent = fmt(g.scores[s]);
  }
  return t;
}

function renderTally(g) {
  if (!$('tally-pop').hidden) {
    const box = $('tally-scroll');
    const wasBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.replaceChildren(buildTally(g, g.phase === 'over'));
    if (wasBottom) box.scrollTop = box.scrollHeight;
  }
}
$('btn-tally').onclick = () => {
  const open = $('tally-pop').hidden;
  hideSizePop();
  $('tally-pop').hidden = !open;
  if (open && shown) { renderTally(shown); $('tally-scroll').scrollTop = $('tally-scroll').scrollHeight; }
};
$('tally-close').onclick = () => { $('tally-pop').hidden = true; };

$('btn-sound').onclick = () => { sfx.muted = !sfx.muted; soundIcon(); };

// Show a game state, animating the dice when a new roll arrived.
async function present(next) {
  const g = next.game;
  const prev = shown;
  room = next;

  if (!g) {
    shown = null;
    gameoverDismissed = false;
    sel = new Set();
    $('gameover').hidden = true;
    view.set(blankSlots(), 0);
    view.setSelection(sel, null, false);
    renderRulesTable(next.options.scoring);
    $('rule-entry').hidden = !next.options.entry;
    renderLobby();
    screen('lobby');
    return;
  }

  screen('game');
  renderRulesTable(g.scoring);
  $('rule-entry').hidden = !g.entry;
  pending = false;
  const newRoll = prev && g.rollId > prev.rollId;
  const turnChanged = !prev || prev.turn !== g.turn || prev.round !== g.round;
  if (newRoll || turnChanged) sel = new Set();
  shown = g;
  renderPlayers(g);
  renderTally(g);

  if (newRoll) {
    animating = true;
    applySelection();
    renderControls();
    $('status').textContent = `${label(g.turn)} ${isMine(g.turn) ? 'roll' : 'rolls'}…`;
    await view.roll(g.slots, g.rollId, sfx.rattle);
    animating = false;
    if (g.last?.hot) { toast('Hot dice! 🔥', 'good', 1300); sfx.hot(); }
    if (g.phase === 'farkle') {
      toast('FARKLE!', 'bad', 1900);
      sfx.farkle();
      if (isMine(g.turn)) buzz('HEAVY');
    }
  } else if (!prev || turnChanged || JSON.stringify(prev.slots) !== JSON.stringify(g.slots)) {
    view.set(g.slots, g.rollId);
  }

  if (prev && g.last?.type === 'bank' && g.seq !== prev.seq && g.phase !== 'over') {
    toast(`${label(g.last.seat)} banked ${fmt(g.last.points)}!`, 'good', 1500);
    sfx.bank();
    if (isMine(g.last.seat)) buzz('LIGHT');
  }
  if (prev && prev.turn !== g.turn && isMine(g.turn) && g.phase !== 'over') { sfx.pop(); buzz('LIGHT'); }

  applySelection();
  renderControls();

  if (g.phase === 'over') {
    if ($('gameover').hidden && !gameoverDismissed) {
      $('winner').textContent = isMine(g.winner) ? 'You won! 🎉' : `${nameOf(g.winner)} wins!`;
      const ol = $('final-scores');
      ol.replaceChildren();
      for (const s of [...g.order].sort((a, b) => g.scores[b] - g.scores[a])) {
        const li = document.createElement('li');
        li.innerHTML = `<b>${fmt(g.scores[s])}</b> `;
        li.append(document.createTextNode(nameOf(s)));
        ol.append(li);
      }
      $('final-tally').replaceChildren(buildTally(g, true));
      $('final-tally').scrollTop = $('final-tally').scrollHeight;
      $('tally-pop').hidden = true;
      $('gameover-sub').textContent = room.you.isHost ? 'Head back to the lobby to play again.' : 'Waiting for the host to start another game.';
      $('again').hidden = !room.you.isHost;
      $('gameover').hidden = false;
      sfx.chime();
    }
  } else {
    gameoverDismissed = false;
    $('gameover').hidden = true;
  }
}

socket.on('room', (r) => {
  if (!wantRoom) return; // we left
  queue.push(r);
  pump();
});

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const next = queue.shift();
      // Skip stale snapshots that change nothing visible: only the newest matters.
      if (queue.length && next.game && queue[0].game && next.game.seq === queue[0].game.seq && shown && next.game.seq === shown.seq) {
        room = next;
        continue;
      }
      await present(next);
    }
  } catch (err) {
    console.error(err);
    animating = false;
  } finally {
    busy = false;
  }
}

// ------------------------------------------------------------------ chat --
// One feed holds chat messages, join/leave notices and game events.
const chatState = { code: null, lastId: 0, unread: 0, open: false, peekTimer: null };
const compact = window.matchMedia('(max-width: 900px)');
try { chatState.open = store.get('chatOpen') !== '0' && !compact.matches; } catch {}

function addLine(node) {
  const log = $('log');
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.append(node);
  while (log.children.length > 150) log.firstChild.remove();
  if (atBottom || node.classList.contains('mine')) log.scrollTop = log.scrollHeight;
}

function addChatMessage(m, live) {
  if (m.id <= chatState.lastId) return;
  chatState.lastId = m.id;
  const div = document.createElement('div');
  if (m.system) {
    div.className = 'sys';
    div.textContent = m.text;
    addLine(div);
    return;
  }
  const mine = room && m.seat !== -1 ? m.seat === room.you.seat && m.name === room.you.name : m.name === store.get('name');
  div.className = 'msg' + (mine ? ' mine' : '');
  const dot = document.createElement('span');
  dot.className = 'mini';
  if (m.seat >= 0) dot.style.setProperty('--c', SEAT_COLORS[m.seat].hex);
  const name = document.createElement('b');
  name.textContent = `${m.name}: `;
  div.append(dot, name, document.createTextNode(m.text));
  addLine(div);
  if (live && !mine) notifyChat(m);
}

function notifyChat(m) {
  if (chatState.open && !document.hidden) return;
  chatState.unread++;
  renderUnread();
  sfx.pop();
  const peek = $('chat-peek');
  peek.textContent = `${m.name}: ${m.text}`;
  peek.hidden = false;
  clearTimeout(chatState.peekTimer);
  chatState.peekTimer = setTimeout(() => (peek.hidden = true), 4500);
}

function renderUnread() {
  const u = $('unread');
  u.hidden = !chatState.unread;
  u.textContent = chatState.unread > 9 ? '9+' : chatState.unread;
}

function setChatOpen(open) {
  chatState.open = open;
  if (!compact.matches) store.set('chatOpen', open ? '1' : '0');
  if (open) { chatState.unread = 0; renderUnread(); $('chat-peek').hidden = true; }
  layoutChat();
  if (open) $('log').scrollTop = $('log').scrollHeight;
}

function layoutChat() {
  $('chatbox').hidden = !(inRoomScreen && chatState.open);
}

function clearChat() {
  $('log').replaceChildren();
  chatState.lastId = 0;
  chatState.unread = 0;
  chatState.code = null;
  renderUnread();
  $('chat-peek').hidden = true;
}

socket.on('chatHistory', ({ code, messages }) => {
  if (!wantRoom) return;
  if (code !== chatState.code) { clearChat(); chatState.code = code; }
  for (const m of messages) addChatMessage(m, false);
});
socket.on('chat', (m) => { if (wantRoom) addChatMessage(m, true); });

function sendChat(text) {
  text = text.trim();
  if (!text) return;
  emit('chat', { text });
}
$('chat-form').onsubmit = (e) => {
  e.preventDefault();
  sendChat($('chat').value);
  $('chat').value = '';
};
for (const r of ['😂', '😱', '🔥', '👍', 'Farkle!', 'GG']) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = r;
  b.onclick = () => sendChat(r);
  $('reactions').append(b);
}
$('btn-chat').onclick = () => setChatOpen(!chatState.open);
$('chat-close').onclick = () => setChatOpen(false);
$('chat-peek').onclick = () => setChatOpen(true);
$('chat').addEventListener('keydown', (e) => { if (e.key === 'Escape') e.target.blur(); });
compact.addEventListener('change', () => { if (compact.matches) setChatOpen(false); else layoutChat(); });

let toastTimer;
function toast(text, kind = '', ms = 1600) {
  const t = $('toast');
  t.textContent = text;
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
