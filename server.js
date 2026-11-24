import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { randomInt, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MAX_SEATS, COLORS, TARGETS, DEFAULT_TARGET, ENTRY_SCORE, SCORING, DEFAULT_SCORING, MODES, MODE_IDS, DEFAULT_MODE } from './shared/config.js';
import { newGameState, applyRoll, applyKeep, applyPass, applyOffer, chooseBotAction, chooseBotOffer } from './shared/rules.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.get('/healthz', (_req, res) => res.send('ok'));
app.use(express.static(path.join(root, 'public')));
app.use('/shared', express.static(path.join(root, 'shared')));
app.use('/vendor/three/build', express.static(path.join(root, 'node_modules/three/build')));
app.use('/vendor/three/addons', express.static(path.join(root, 'node_modules/three/examples/jsm')));

const http = createServer(app);
// The Android app loads the client from https://localhost and connects here.
const io = new Server(http, { cors: { origin: ['https://localhost', 'http://localhost', 'capacitor://localhost'] } });

/** @type {Map<string, Room>} */
const rooms = new Map();
const ROOM_IDLE_MS = 30 * 60 * 1000;
// Testing aid: FARKLE_FORCE_ROLLS=1,5,2 makes the dice cycle through those values.
const forced = (process.env.FARKLE_FORCE_ROLLS || '').split(',').map(Number).filter((n) => n >= 1 && n <= 6);
let forcedAt = 0;
const rollDie = () => (forced.length ? forced[forcedAt++ % forced.length] : randomInt(1, 7));
const BOT_NAMES = ['Lucky Lou', 'Snake-Eyes Sam', 'Dicey Dot', 'Boxcars Bob', 'Roller Rae', 'Gambler Gus'];

function newCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do code = Array.from({ length: 4 }, () => letters[randomInt(letters.length)]).join('');
  while (rooms.has(code));
  return code;
}

const cleanName = (n) => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Player';

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map(); // token -> {token, name, socketId, connected}
    this.seats = Array(MAX_SEATS).fill(null); // {token, name, bot}
    this.host = null;
    this.game = null;
    this.options = { target: DEFAULT_TARGET, scoring: DEFAULT_SCORING, entry: ENTRY_SCORE, mode: DEFAULT_MODE };
    this.timer = null;
    this.chat = [];
    this.chatId = 0;
    this.touched = Date.now();
  }

  seatOf(token) {
    return this.seats.findIndex((s) => s && s.token === token);
  }

  publicState() {
    return {
      code: this.code,
      options: this.options,
      seats: this.seats.map((s, i) => s && {
        name: s.name,
        bot: !!s.bot,
        connected: s.bot || !!this.players.get(s.token)?.connected,
        color: COLORS[s.color],
      }),
      spectators: [...this.players.values()].filter((p) => p.connected && this.seatOf(p.token) === -1).map((p) => p.name),
      hostName: this.players.get(this.host)?.name ?? null,
      game: this.game,
    };
  }

  broadcast() {
    this.touched = Date.now();
    const state = this.publicState();
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      io.to(p.socketId).emit('room', { ...state, you: { seat: this.seatOf(p.token), isHost: p.token === this.host, name: p.name } });
    }
  }

  // Whether the current turn should be played automatically.
  autoTurn() {
    const seat = this.seats[this.game.turn];
    if (!seat) return true;
    return seat.bot || !this.players.get(seat.token)?.connected;
  }

  // The preferred colour if nobody has it, otherwise the first free one.
  pickColor(pref) {
    const used = new Set(this.seats.filter(Boolean).map((s) => s.color));
    if (Number.isInteger(pref) && pref >= 0 && pref < COLORS.length && !used.has(pref)) return pref;
    return COLORS.findIndex((_, i) => !used.has(i));
  }

  nameOf(seat) {
    return this.seats[seat]?.name ?? `Player ${seat + 1}`;
  }

  // Run a game action, note it in the chat feed, and let the clients see it.
  act(fn) {
    const g = this.game;
    const seat = g.turn;
    fn(g);
    const l = g.last;
    if (l?.type === 'bank') this.addChat(null, `${this.nameOf(seat)} banked ${l.points} (${g.scores[seat]} total)`, true);
    else if (l?.type === 'farkle' && l.highStakes) this.addChat(null, `${this.nameOf(seat)} farkled the high stakes roll!`, true);
    else if (l?.type === 'farkle') this.addChat(null, `${this.nameOf(seat)} farkled${l.lost ? ` and lost ${l.lost}` : ''}!`, true);
    else if (l?.type === 'decline') this.addChat(null, `${this.nameOf(seat)} passed on the high stakes roll`, true);
    else if (l?.type === 'roll' && l.highStakes) this.addChat(null, `${this.nameOf(seat)} took the high stakes roll for +${l.stake}!`, true);
    else if (l?.hot) this.addChat(null, `${this.nameOf(seat)} has hot dice!`, true);
    if (g.final && l?.type === 'bank' && g.final.trigger === seat && g.final.pending.length === g.order.length - 1) {
      this.addChat(null, `${this.nameOf(seat)} reached ${g.target}! Everyone else gets one last turn.`, true);
    }
    if (g.phase === 'offer') this.addChat(null, `High stakes! ${this.nameOf(g.turn)} can roll ${g.offer.dice} dice for +${g.offer.stake}.`, true);
    if (g.phase === 'over') this.addChat(null, `${this.nameOf(g.winner)} wins with ${g.scores[g.winner]}!`, true);
    this.after();
  }

  schedule() {
    clearTimeout(this.timer);
    const g = this.game;
    if (!g || g.phase === 'over') return;
    // Give clients time to animate the last action before acting again.
    const last = g.last;
    const animMs = !last ? 300 : last.type === 'roll' ? 1400 : last.type === 'farkle' ? 2200 : last.type === 'bank' ? 1600 : 300;
    if (g.phase === 'farkle') {
      this.timer = setTimeout(() => this.act((x) => applyPass(x)), animMs);
    } else if (this.autoTurn()) {
      this.timer = setTimeout(() => {
        if (g.phase === 'roll') this.act((x) => applyRoll(x, rollDie));
        else if (g.phase === 'select') {
          const { keep, bank } = chooseBotAction(g);
          this.act((x) => applyKeep(x, keep, bank, rollDie));
        } else if (g.phase === 'offer') this.act((x) => applyOffer(x, chooseBotOffer(x), rollDie));
      }, animMs + 400 + randomInt(700));
    }
  }

  after() {
    this.broadcast();
    this.schedule();
  }

  // Chat goes out immediately on its own event, separate from game state, so
  // it is never held up behind dice animations.
  addChat(name, text, system = false, seat = -1) {
    const msg = { id: ++this.chatId, name, seat, text: String(text).slice(0, 200), system, t: Date.now() };
    this.chat.push(msg);
    if (this.chat.length > 100) this.chat.shift();
    io.to(this.code).emit('chat', msg);
  }
}

io.on('connection', (socket) => {
  // Each browser keeps a random token so it can reconnect to its seat.
  let token = String(socket.handshake.auth?.token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) token = randomBytes(16).toString('hex');
  socket.emit('token', token);
  let room = null;

  const fail = (ack, msg) => typeof ack === 'function' && ack({ error: msg });
  const ok = (ack, data = {}) => typeof ack === 'function' && ack({ ok: true, ...data });

  function enter(r, name) {
    if (room && room !== r) leave();
    room = r;
    socket.join(r.code);
    const existing = r.players.get(token);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      if (name) existing.name = name;
    } else {
      r.players.set(token, { token, name, socketId: socket.id, connected: true });
      r.addChat(null, `${name} joined`, true);
    }
    socket.emit('chatHistory', { code: r.code, messages: r.chat.slice(-50) });
    const seat = r.seatOf(token);
    if (seat !== -1) r.seats[seat].name = r.players.get(token).name;
    if (!r.host || !r.players.get(r.host)?.connected) r.host = token;
    r.after();
  }

  function leave() {
    const r = room;
    if (!r) return;
    room = null;
    socket.leave(r.code);
    const p = r.players.get(token);
    r.players.delete(token);
    const seat = r.seatOf(token);
    if (seat !== -1) {
      // Mid-game a computer takes over the seat; in the lobby it simply frees up.
      if (r.game && r.game.order.includes(seat)) r.seats[seat] = { token: `bot-${seat}`, name: `${p?.name ?? 'Player'} (bot)`, bot: true, color: r.seats[seat].color };
      else r.seats[seat] = null;
    }
    if (p) r.addChat(null, `${p.name} left`, true);
    if (r.host === token) r.host = [...r.players.values()].find((x) => x.connected)?.token ?? null;
    if (r.players.size === 0) { clearTimeout(r.timer); rooms.delete(r.code); return; }
    r.after();
  }

  socket.on('createRoom', ({ name, color } = {}, ack) => {
    const r = new Room(newCode());
    rooms.set(r.code, r);
    r.host = token;
    enter(r, cleanName(name));
    const free = r.seats.findIndex((s) => !s);
    r.seats[free] = { token, name: cleanName(name), color: r.pickColor(color) };
    r.broadcast();
    ok(ack, { code: r.code });
  });

  socket.on('joinRoom', ({ code, name, color } = {}, ack) => {
    const r = rooms.get(String(code ?? '').toUpperCase().trim());
    if (!r) return fail(ack, 'No room with that code.');
    enter(r, cleanName(name));
    // Seat newcomers automatically while the game hasn't started.
    if (!r.game && r.seatOf(token) === -1) {
      const free = r.seats.findIndex((s) => !s);
      if (free !== -1) { r.seats[free] = { token, name: cleanName(name), color: r.pickColor(color) }; r.broadcast(); }
    }
    ok(ack, { code: r.code });
  });

  // Inside a room
  const inLobby = () => room && !room.game;
  const isHost = () => room && room.host === token;

  socket.on('sit', ({ seat } = {}, ack) => {
    if (!inLobby()) return fail(ack, 'Game already started.');
    if (!(seat >= 0 && seat < MAX_SEATS) || room.seats[seat]) return fail(ack, 'Seat taken.');
    const cur = room.seatOf(token);
    const keep = cur !== -1 ? room.seats[cur].color : undefined;
    if (cur !== -1) room.seats[cur] = null;
    room.seats[seat] = { token, name: room.players.get(token).name, color: room.pickColor(keep) };
    room.broadcast();
    ok(ack);
  });

  socket.on('stand', (_, ack) => {
    if (!inLobby()) return fail(ack, 'Game already started.');
    const cur = room.seatOf(token);
    if (cur !== -1) room.seats[cur] = null;
    room.broadcast();
    ok(ack);
  });

  socket.on('addBot', ({ seat } = {}, ack) => {
    if (!inLobby() || !isHost()) return fail(ack, 'Only the host can add computer players.');
    if (!(seat >= 0 && seat < MAX_SEATS) || room.seats[seat]) return fail(ack, 'Seat taken.');
    room.seats[seat] = { token: `bot-${seat}`, name: BOT_NAMES[seat], bot: true, color: room.pickColor() };
    room.broadcast();
    ok(ack);
  });

  socket.on('removeSeat', ({ seat } = {}, ack) => {
    if (!inLobby() || !isHost()) return fail(ack, 'Only the host can do that.');
    if (!room.seats[seat]) return ok(ack);
    if (room.seats[seat].token === token) return fail(ack, 'Use "stand up" for yourself.');
    room.seats[seat] = null;
    room.broadcast();
    ok(ack);
  });

  // Pick a colour for yourself (or, as host, for a computer player).
  socket.on('setColor', ({ color, seat } = {}, ack) => {
    if (!inLobby()) return fail(ack, 'Colors are chosen before the game starts.');
    const mine = room.seatOf(token);
    const target = seat === undefined ? mine : seat;
    if (!room.seats[target]) return fail(ack, 'Sit down first.');
    if (target !== mine && !(isHost() && room.seats[target].bot)) return fail(ack, 'You can only change your own color.');
    if (!Number.isInteger(color) || color < 0 || color >= COLORS.length) return fail(ack, 'Unknown color.');
    const holder = room.seats.findIndex((s) => s && s.color === color);
    if (holder !== -1 && holder !== target) return fail(ack, `${COLORS[color].name} is already taken.`);
    room.seats[target].color = color;
    room.broadcast();
    ok(ack);
  });

  socket.on('setOptions', ({ target, scoring, entry, mode } = {}, ack) => {
    if (!inLobby() || !isHost()) return fail(ack, 'Only the host can change the rules.');
    if (target !== undefined) {
      if (!TARGETS.includes(target)) return fail(ack, 'Unknown target score.');
      room.options.target = target;
    }
    if (entry !== undefined) {
      if (entry !== 0 && entry !== ENTRY_SCORE) return fail(ack, 'Unknown entry rule.');
      room.options.entry = entry;
    }
    if (mode !== undefined) {
      if (!MODE_IDS.includes(mode)) return fail(ack, 'Unknown game mode.');
      room.options.mode = mode;
    }
    if (scoring !== undefined) {
      if (!Object.hasOwn(SCORING, scoring)) return fail(ack, 'Unknown scoring rules.');
      room.options.scoring = scoring;
    }
    room.broadcast();
    ok(ack);
  });

  socket.on('start', (_, ack) => {
    if (!inLobby() || !isHost()) return fail(ack, 'Only the host can start.');
    const seated = room.seats.map((s, i) => (s ? i : -1)).filter((i) => i !== -1);
    if (seated.length < 2) return fail(ack, 'Need at least 2 players.');
    room.game = newGameState(seated, room.options);
    room.addChat(null, `Game started! ${SCORING[room.options.scoring].name} scoring, first to ${room.options.target} wins${room.options.entry ? '' : ', no minimum to get on the board'}${room.options.mode === 'highstakes' ? '. High Stakes mode is on' : ''}.`, true);
    room.after();
    ok(ack);
  });

  socket.on('roll', (_, ack) => {
    const g = room?.game;
    if (!g || g.phase !== 'roll' || room.seatOf(token) !== g.turn) return fail(ack, 'Not your roll.');
    room.act((x) => applyRoll(x, rollDie));
    ok(ack);
  });

  // Keep the chosen dice, then bank the turn or roll the rest.
  socket.on('keep', ({ dice, bank } = {}, ack) => {
    const g = room?.game;
    if (!g || g.phase !== 'select' || room.seatOf(token) !== g.turn) return fail(ack, 'Not your move.');
    try {
      room.act((x) => applyKeep(x, dice, !!bank, rollDie));
    } catch (e) {
      return fail(ack, e.message);
    }
    ok(ack);
  });

  // High Stakes: take (or pass on) the dice the previous player left behind.
  socket.on('offer', ({ take } = {}, ack) => {
    const g = room?.game;
    if (!g || g.phase !== 'offer' || room.seatOf(token) !== g.turn) return fail(ack, 'No high stakes offer for you.');
    room.act((x) => applyOffer(x, !!take, rollDie));
    ok(ack);
  });

  socket.on('backToLobby', (_, ack) => {
    if (!room?.game || !isHost()) return fail(ack, 'Only the host can do that.');
    if (room.game.phase !== 'over') return fail(ack, 'Game still in progress.');
    clearTimeout(room.timer);
    room.game = null;
    room.after();
    ok(ack);
  });

  // At most 5 messages per 5 seconds per connection.
  const chatTimes = [];
  socket.on('chat', ({ text } = {}, ack) => {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!room || !clean) return fail(ack, 'Nothing to send.');
    const now = Date.now();
    while (chatTimes.length && now - chatTimes[0] > 5000) chatTimes.shift();
    if (chatTimes.length >= 5) return fail(ack, 'Slow down a little!');
    chatTimes.push(now);
    room.addChat(room.players.get(token)?.name ?? '?', clean, false, room.seatOf(token));
    ok(ack);
  });

  socket.on('leave', (_, ack) => { leave(); ok(ack); });

  socket.on('disconnect', () => {
    const r = room;
    if (!r) return;
    const p = r.players.get(token);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      if (r.host === token) r.host = [...r.players.values()].find((x) => x.connected)?.token ?? r.host;
      // Players keep their seat so they can reconnect; mid-game the computer
      // plays for them until they come back.
      r.after();
    }
  });
});

// Drop rooms nobody has touched in a while.
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    const anyone = [...r.players.values()].some((p) => p.connected);
    if (!anyone && now - r.touched > ROOM_IDLE_MS) { clearTimeout(r.timer); rooms.delete(code); }
  }
}, 60 * 1000).unref();

const PORT = Number(process.env.PORT) || 3000;
http.listen(PORT, () => console.log(`Farkle server listening on http://localhost:${PORT}`));
