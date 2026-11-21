// Coin Grab worker — single file, no imports. Durable Object binding: ROOMS, class: GameRoom.
// ---- src/shared/protocol.js
// Shared validation + sanitizing, used by worker and client.
const MAX_MSG_BYTES = 256;
const MAX_NAME = 16;
const MAX_ROOM = 32;

function sanitizeRoom(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, MAX_ROOM);
}

function isValidRoom(s) {
  return typeof s === 'string' && /^[a-z0-9_-]{1,32}$/.test(s);
}

function sanitizeName(s) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

function isValidId(s) {
  return typeof s === 'string' && /^[A-Za-z0-9]{6,32}$/.test(s);
}

// Parse one client message. Returns a normalized object or null if invalid.
function parseClientMsg(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MSG_BYTES) return null;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.t === 'in') {
    const x = m.x, y = m.y;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < -1 || x > 1 || y < -1 || y > 1) return null;
    return { t: 'in', x, y };
  }
  if (m.t === 'ping') return { t: 'ping' };
  return null;
}

// Simple token bucket: capacity tokens, refills `rate` per second.
function makeBucket(capacity, rate, now) {
  return { tokens: capacity, capacity, rate, last: now };
}

function takeToken(b, now) {
  const dt = Math.max(0, (now - b.last) / 1000);
  b.last = now;
  b.tokens = Math.min(b.capacity, b.tokens + dt * b.rate);
  if (b.tokens >= 1) { b.tokens -= 1; return true; }
  return false;
}

// ---- src/shared/game.js
// Pure Coin Grab game logic. No I/O, deterministic given rand().
const ARENA = 100;
const PLAYER_R = 4;
const COIN_R = 3;
const SPEED = 40;          // units per second
const WIN_SCORE = 5;
const WIN_PAUSE = 3;       // seconds
const MAX_PLAYERS = 8;
const COLORS = ['#ff5d73', '#4dd2ff', '#ff6bd6', '#7cff6b', '#c77dff', '#ff9f43', '#f5f5f5', '#00e0b0'];

function createGame(rand) {
  const g = { rand: rand || Math.random, players: new Map(), coin: { x: 50, y: 50 }, phase: 'play', winner: '', pause: 0 };
  placeCoin(g);
  return g;
}

function placeCoin(g) {
  const m = COIN_R + 2;
  for (let tries = 0; tries < 20; tries++) {
    const x = m + g.rand() * (ARENA - 2 * m);
    const y = m + g.rand() * (ARENA - 2 * m);
    let ok = true;
    for (const p of g.players.values()) {
      if (Math.hypot(p.x - x, p.y - y) < PLAYER_R + COIN_R + 6) { ok = false; break; }
    }
    g.coin = { x, y };
    if (ok) return;
  }
}

function freeColor(g) {
  const used = new Set([...g.players.values()].map(p => p.c));
  for (let i = 0; i < COLORS.length; i++) if (!used.has(i)) return i;
  return 0;
}

function addPlayer(g, id, name) {
  const existing = g.players.get(id);
  if (existing) { existing.name = name; existing.online = true; return existing; }
  if (g.players.size >= MAX_PLAYERS) return null;
  const p = {
    id, name, c: freeColor(g), score: 0, online: true, offSince: 0,
    x: PLAYER_R + g.rand() * (ARENA - 2 * PLAYER_R),
    y: PLAYER_R + g.rand() * (ARENA - 2 * PLAYER_R),
    ix: 0, iy: 0,
  };
  g.players.set(id, p);
  return p;
}

function removePlayer(g, id) { g.players.delete(id); }

function setInput(g, id, x, y) {
  const p = g.players.get(id);
  if (!p) return;
  if (!Number.isFinite(x) || !Number.isFinite(y)) { x = 0; y = 0; }
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  p.ix = x; p.iy = y;
}

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// Advance by dt seconds. Returns list of events.
function step(g, dt) {
  const ev = [];
  dt = clamp(dt, 0, 0.25);
  if (g.phase === 'win') {
    g.pause -= dt;
    if (g.pause <= 0) {
      g.phase = 'play'; g.winner = '';
      for (const p of g.players.values()) p.score = 0;
      placeCoin(g);
      ev.push({ e: 'reset' });
    }
    return ev;
  }
  for (const p of g.players.values()) {
    if (!p.online) continue;
    p.x = clamp(p.x + p.ix * SPEED * dt, PLAYER_R, ARENA - PLAYER_R);
    p.y = clamp(p.y + p.iy * SPEED * dt, PLAYER_R, ARENA - PLAYER_R);
  }
  for (const p of g.players.values()) {
    if (!p.online) continue;
    if (Math.hypot(p.x - g.coin.x, p.y - g.coin.y) <= PLAYER_R + COIN_R) {
      p.score++;
      ev.push({ e: 'coin', id: p.id });
      if (p.score >= WIN_SCORE) {
        g.phase = 'win'; g.winner = p.name; g.pause = WIN_PAUSE;
        ev.push({ e: 'win', id: p.id, name: p.name });
      } else {
        placeCoin(g);
      }
      break; // one coin per tick
    }
  }
  return ev;
}

const r1 = v => Math.round(v * 10) / 10;

function snapshot(g) {
  const p = [];
  for (const q of g.players.values()) p.push({ i: q.id, n: q.name, x: r1(q.x), y: r1(q.y), s: q.score, c: q.c, o: q.online ? 1 : 0 });
  return { t: 's', p, c: { x: r1(g.coin.x), y: r1(g.coin.y) }, ph: g.phase, w: g.winner };
}

// ---- src/worker/token.js
// LiveKit join token: HS256 JWT signed with WebCrypto.
const TOKEN_TTL = 6 * 3600;

function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlStr(str) { return b64url(new TextEncoder().encode(str)); }

async function signJwt(payload, secret) {
  const head = b64urlStr(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlStr(JSON.stringify(payload));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + b64url(new Uint8Array(sig));
}

async function liveKitToken(apiKey, apiSecret, room, name, identity, nowSec) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  return signJwt({
    iss: apiKey,
    sub: identity,
    name,
    nbf: now - 10,
    iat: now,
    exp: now + TOKEN_TTL,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true },
  }, apiSecret);
}

// ---- src/worker/room.js


const DATA_VERSION = 'coingrab-1';
const TICK_MS = 50;
const OFFLINE_DROP_MS = 20000;
const MAX_WIN_NAMES = 50;

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // id -> { ws, bucket, bad }
    this.game = createGame();
    this.wins = {};
    this.loaded = false;
    this.timer = null;
    this.lastTick = 0;
    const load = () => this.load();
    this.ready = state && state.blockConcurrencyWhile ? state.blockConcurrencyWhile(load) : load();
  }

  async load() {
    try {
      const st = this.state.storage;
      const v = await st.get('v');
      if (v !== DATA_VERSION) {
        // Old game's data (or empty room): wipe once, then stamp our version.
        await st.deleteAll();
        if (st.deleteAlarm) { try { await st.deleteAlarm(); } catch (e) {} }
        await st.put('v', DATA_VERSION);
        this.wins = {};
      } else {
        const w = await st.get('wins');
        this.wins = cleanWins(w);
      }
      this.loaded = true;
    } catch (e) {
      this.loaded = false; // never write if load failed
    }
  }

  async save() {
    if (!this.loaded) return;
    try { await this.state.storage.put('wins', this.wins); } catch (e) {}
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const name = sanitizeName(url.searchParams.get('name'));
    const id = url.searchParams.get('id') || '';
    const room = url.searchParams.get('room') || '';
    if (!name || !isValidId(id) || !isValidRoom(room)) return new Response('bad params', { status: 400 });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    server.accept();
    this.accept(server, name, id);
    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const sess of this.sessions.values()) { try { sess.ws.send(s); } catch (e) {} }
  }

  accept(ws, name, id) {
    const old = this.sessions.get(id);
    if (old) { this.sessions.delete(id); try { old.ws.close(4000, 'replaced'); } catch (e) {} }
    const p = addPlayer(this.game, id, name);
    if (!p) {
      this.send(ws, { t: 'err', m: 'Room is full' });
      try { ws.close(4001, 'full'); } catch (e) {}
      return;
    }
    const sess = { ws, bucket: makeBucket(30, 25, Date.now()), bad: 0 };
    this.sessions.set(id, sess);
    this.send(ws, { t: 'hi', id });
    this.send(ws, { t: 'wins', w: this.wins });
    this.send(ws, snapshot(this.game));

    ws.addEventListener('message', (ev) => this.onMessage(id, sess, ev.data));
    const gone = () => this.onClose(id, sess);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    this.ensureTimer();
  }

  onMessage(id, sess, data) {
    if (this.sessions.get(id) !== sess) return;
    if (!takeToken(sess.bucket, Date.now())) { this.strike(id, sess, 1); return; }
    const m = parseClientMsg(typeof data === 'string' ? data : null);
    if (!m) { this.strike(id, sess, 5); return; }
    if (m.t === 'in') setInput(this.game, id, m.x, m.y);
    else if (m.t === 'ping') this.send(sess.ws, { t: 'pong' });
  }

  strike(id, sess, n) {
    sess.bad += n;
    if (sess.bad > 300) { try { sess.ws.close(1008, 'abuse'); } catch (e) {} this.onClose(id, sess); }
  }

  onClose(id, sess) {
    if (this.sessions.get(id) !== sess) return;
    this.sessions.delete(id);
    const p = this.game.players.get(id);
    if (p) { p.online = false; p.offSince = Date.now(); p.ix = 0; p.iy = 0; }
  }

  ensureTimer() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;
    for (const p of [...this.game.players.values()]) {
      if (!p.online && now - p.offSince > OFFLINE_DROP_MS) removePlayer(this.game, p.id);
    }
    const ev = step(this.game, dt);
    for (const e of ev) {
      if (e.e === 'win') {
        this.wins[e.name] = (this.wins[e.name] || 0) + 1;
        this.wins = cleanWins(this.wins);
        this.save();
        this.broadcast({ t: 'wins', w: this.wins });
      }
    }
    this.broadcast(snapshot(this.game));
    if (this.sessions.size === 0) { clearInterval(this.timer); this.timer = null; }
  }
}

function cleanWins(w) {
  const out = {};
  if (!w || typeof w !== 'object') return out;
  const entries = Object.entries(w)
    .filter(([k, v]) => typeof k === 'string' && k.length <= 16 && Number.isInteger(v) && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WIN_NAMES);
  for (const [k, v] of entries) out[k] = v;
  return out;
}

// ---- src/worker/main.js


const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Upgrade',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function withCors(resp) {
  if (resp.status === 101) {
    const h = new Headers(resp.headers);
    for (const k in CORS) h.set(k, CORS[k]);
    return new Response(null, { status: 101, webSocket: resp.webSocket, headers: h });
  }
  const h = new Headers(resp.headers);
  for (const k in CORS) h.set(k, CORS[k]);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function randId(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (path === '/health') return json({ ok: true });

      if (path === '/token') {
        const room = url.searchParams.get('room') || '';
        const name = sanitizeName(url.searchParams.get('name'));
        if (!isValidRoom(room) || !name) return json({ error: 'bad room or name' }, 400);
        if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return json({ error: 'voice not configured' }, 500);
        const idp = url.searchParams.get('id');
        const identity = name + '-' + (isValidId(idp || '') ? idp.slice(0, 12) : randId(6));
        const token = await liveKitToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, room, name, identity);
        return json({ token });
      }

      if (path === '/ws') {
        const room = url.searchParams.get('room') || '';
        if (!isValidRoom(room)) return json({ error: 'bad room' }, 400);
        if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'expected websocket' }, 426);
        const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
        return withCors(await stub.fetch(request));
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error' }, 500);
    }
  },
};
