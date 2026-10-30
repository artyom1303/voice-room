// ═══════════════════════════════════════════════════════════════════
//  Voice Room — Cloudflare Worker (token server + game rooms)
//
//  Routes:
//    GET  /health                  → sanity check
//    GET  /token?room=…&name=…     → LiveKit join token (JWT, HS256)
//    WS   /ws?room=…&name=…&id=…   → game room (Durable Object GameRoom)
//
//  Environment variables (Settings → Variables and Secrets):
//    LIVEKIT_API_KEY      (Secret)
//    LIVEKIT_API_SECRET   (Secret)
//
//  Bindings (Settings → Bindings → Durable Object):
//    ROOMS  →  class GameRoom
//
//  World: 10,000 × 2,000 tiles, 1 tile = 1 m, procedurally generated
//  from a per-room seed (identical on every client and here — the
//  terrain code below must stay in sync with index.html). The Durable
//  Object stores ONLY the seed, player positions, and the list of
//  dug/placed blocks ("mods"). Nobody is ever "host": the world
//  survives everyone leaving and is restored on re-entry.
// ═══════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ROOM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Ghost reaping: clients send a heartbeat every 5 s; the room sweeps
// every SWEEP_MS and removes anyone silent for more than STALE_MS.
const SWEEP_MS = 20000;
const STALE_MS = 30000;

// ── World constants (KEEP IN SYNC with index.html) ────────────────
const WORLD = {
  w: 10000,     // tiles wide (1 tile = 1 m)
  h: 4000,      // tiles deep — surface sits in the middle (~y 2000)
  hear: 16,     // proximity voice range = 20 player widths (0.8 m)
  reach: 5,     // dig/place reach in tiles
  spawnX: 5000, // everyone spawns near world center → always in earshot
};
const PW = 0.8, PH = 1.8; // player collision box (m)

// Tile types
const T_AIR = 0, T_GRASS = 1, T_DIRT = 2, T_STONE = 3, T_ORE = 4, T_WOOD = 5, T_BEDROCK = 6,
      T_LEAVES = 7, T_ROCK2 = 8, T_ROCK3 = 9, T_ROCK4 = 10, T_LAVA = 11;
// Seconds to mine per type (bedrock/lava = unbreakable, not in the table)
const HARD = { 1: 0.5, 2: 0.7, 3: 1.8, 4: 2.6, 5: 1.1, 7: 0.3, 8: 3.2, 9: 5.5, 10: 9 };
const PLACEABLE = { 2: 1, 3: 1, 4: 1, 5: 1, 7: 1, 8: 1, 9: 1, 10: 1 };

// ── Deterministic terrain (KEEP IN SYNC with index.html) ──────────
function hash2(x, y, seed) {
  let h = ((x | 0) * 374761393 + (y | 0) * 668265263 + (seed | 0) * 974711) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function vnoise1(x, seed) {
  const xi = Math.floor(x), xf = x - xi;
  const a = hash2(xi, 0, seed), b = hash2(xi + 1, 0, seed);
  return a + (b - a) * smooth(xf);
}
function fbm1(x, seed, oct) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { v += vnoise1(x * f, seed + i * 101) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return v / norm;
}
function vnoise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const u = smooth(xf), v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm2(x, y, seed, oct) {
  let v = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { v += vnoise2(x * f, y * f, seed + i * 733) * amp; norm += amp; amp *= 0.5; f *= 2; }
  return v / norm;
}
function heightAt(seed, x) { // y of the surface (grass) row; y grows down
  const hills = fbm1(x / 140, seed, 3) - 0.5;
  const broad = fbm1(x / 800, seed + 7, 2) - 0.5;
  return clamp(Math.floor(2000 + hills * 76 + broad * 140), 40, WORLD.h - 60);
}
// trees: one per 9-column bucket (bucket hash picks position & trunk
// height), so trunks never touch. Trunks live ENTIRELY in the back layer
// (walk-through); only the LEAVES crown stays up front. None near spawn.
function treeCol(seed, c) { // is there a trunk at column c?
  if (Math.abs(c - WORLD.spawnX) < 8) return false;
  const b = Math.floor(c / 9);
  if (hash2(b, 0, seed + 91) > 0.55) return false;
  return c === b * 9 + 1 + ((hash2(b, 1, seed + 92) * 7) | 0);
}
function trunkH(seed, c) { return 4 + ((hash2(c, 2, seed + 95) * 3) | 0); } // 4–6
function trunkAt(seed, x, y) { // back layer: the trunk column, else AIR
  if (!treeCol(seed, x)) return T_AIR;
  const hc = heightAt(seed, x), top = hc - trunkH(seed, x);
  return y >= top && y < hc ? T_WOOD : T_AIR;
}
function crownAt(seed, x, y) { // front layer: the leafy crown, else AIR
  for (let c = x - 3; c <= x + 3; c++) {
    if (!treeCol(seed, c)) continue;
    const hc = heightAt(seed, c), top = hc - trunkH(seed, c);
    if (y < top - 2 || y > top + 1) continue;           // crown = 4 tidy rows
    const dx = Math.abs(x - c), dy = y - top;
    const R = 2 + ((hash2(c, 3, seed + 98) * 2) | 0);   // crown radius 2 or 3
    if (dy === -2 || dy === 1) { if (dx > 1) continue; }
    else if (dx > R || (dx === R && R === 3 && dy === -1)) continue; // round top corners
    return T_LEAVES;
  }
  return T_AIR;
}
function tileAt(seed, x, y) {
  x |= 0; y |= 0;
  if (y < 0) return T_AIR;
  if (x < 0 || x >= WORLD.w) return T_BEDROCK; // side walls
  if (y >= WORLD.h - 8) return T_LAVA;         // glowing lava floor
  const h = heightAt(seed, x);
  if (y < h) return crownAt(seed, x, y);       // sky band: crowns up front
  const d = y - h;
  if (d > 6 && fbm2(x / 22, y / 22, seed + 31, 2) > 0.62) return T_AIR; // caves
  if (d === 0) return T_GRASS;
  if (d < 5) return T_DIRT;
  if (hash2(x, y, seed ^ 0x9e37) < (d > 200 ? 0.03 : 0.02)) return T_ORE;
  // rock grows harder & darker with depth — perlin-wobbled boundaries
  const dd = d + (fbm2(x / 55, y / 55, seed + 43, 2) - 0.5) * 36;
  if (dd > 900) return T_ROCK4;
  if (dd > 480) return T_ROCK3;
  if (dd > 190) return T_ROCK2;
  return T_STONE;
}
// Natural BACK layer (KEEP IN SYNC with index.html): terrain always has
// a back wall — the same strata as the front but with no cave hollows —
// and tree trunks stand in the back above ground. Never collides.
function backAt(seed, x, y) {
  x |= 0; y |= 0;
  if (y < 0) return T_AIR;
  if (x < 0 || x >= WORLD.w) return T_BEDROCK;
  if (y >= WORLD.h - 8) return T_LAVA;
  const h = heightAt(seed, x);
  if (y < h) return trunkAt(seed, x, y);       // sky band: just trunks
  const d = y - h;
  if (d < 5) return T_DIRT;                    // dirt wall behind grass too
  if (hash2(x, y, seed ^ 0x9e37) < (d > 200 ? 0.03 : 0.02)) return T_ORE;
  const dd = d + (fbm2(x / 55, y / 55, seed + 43, 2) - 0.5) * 36;
  if (dd > 900) return T_ROCK4;
  if (dd > 480) return T_ROCK3;
  if (dd > 190) return T_ROCK2;
  return T_STONE;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, service: "voice-room-token-server", game: !!env.ROOMS });
    }

    if (url.pathname === "/token") {
      return handleToken(url, env);
    }

    if (url.pathname === "/ws") {
      if (!env.ROOMS) {
        return json({
          error: "Game rooms not set up yet — add the ROOMS Durable Object binding (Setup Guide, Part 5).",
        }, 501);
      }
      const room = (url.searchParams.get("room") || "").toLowerCase().trim();
      if (!ROOM_PATTERN.test(room)) {
        return json({ error: "Invalid room name — use 1–32 of: a–z, 0–9, -, _" }, 400);
      }
      // One Durable Object instance per room name = one world per room.
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }

    return json({ error: "Not found" }, 404);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ── LiveKit token minting ─────────────────────────────────────────

async function handleToken(url, env) {
  const room = (url.searchParams.get("room") || "").toLowerCase().trim();
  const name = (url.searchParams.get("name") || "").trim().slice(0, 32);

  if (!ROOM_PATTERN.test(room)) {
    return json({ error: "Invalid room name — use 1–32 of: a–z, 0–9, -, _" }, 400);
  }
  if (name.length < 1) {
    return json({ error: "Please enter a name." }, 400);
  }
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) {
    return json({ error: "Server is not configured yet (missing LiveKit secrets)." }, 500);
  }

  // Identity must be unique per connection; `name` stays human-readable.
  // The game WebSocket uses this same identity, so voice volume can be
  // matched to a player's on-screen block for proximity chat.
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";
  const identity = `${slug}-${Math.random().toString(36).slice(2, 8)}`;

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: env.LIVEKIT_API_KEY,
    sub: identity,
    name: name,
    iat: now,
    nbf: now - 10,
    exp: now + 6 * 60 * 60,
    video: {
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
    },
  };

  const token = await signJwt(payload, env.LIVEKIT_API_SECRET);
  return json({ token });
}

// ── Minimal HS256 JWT signer (Web Crypto only, zero dependencies) ──

async function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const data = b64urlText(JSON.stringify(header)) + "." + b64urlText(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return data + "." + b64urlBytes(new Uint8Array(signature));
}

function b64urlText(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

function b64urlBytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ═══════════════════════════════════════════════════════════════════
//  GameRoom — Durable Object. One instance per room name.
//
//  Client → here:   { t:"p", x, y }              position update
//                   { t:"hb" }                    heartbeat
//                   { t:"dig", x, y, l }          break tile (validated)
//                   { t:"place", x, y, v, l }     place tile (validated)
//  Here → client:   { t:"init", you, world, seed, players, mods }
//                   { t:"+", id, name, x, y }     someone joined
//                   { t:"p", id, x, y }           someone moved
//                   { t:"-", id }                 someone left
//                   { t:"b", x, y, v, l }         tile changed (0 = air)
//
//  l = layer: 0 front (solid), 1 back (walk-through wall). Mods persist
//  as [x, y, v, l] — old 3-element entries are front-layer.
//
//  The terrain itself is procedural; only edits ("mods"), the seed,
//  and player positions are persisted.
// ═══════════════════════════════════════════════════════════════════

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.players = new Map(); // connected: id -> { name, x, y, cid, lastSeen }
    this.saved = {};          // persisted:  id -> { name, x, y }
    this.mods = [];           // persisted:  [[x, y, v, l], ...] every dig/place ever
    this.modMap = new Map();  // "x,y" -> v  FRONT (fast lookup mirror of mods)
    this.backModMap = new Map(); // "x,y" -> v  BACK
    this.seed = 0;
    this.saveTimer = null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      try {
        this.saved = (await ctx.storage.get("saved")) || {};
        this.mods = (await ctx.storage.get("mods")) || [];
        let s = await ctx.storage.get("seed");
        if (!s) { s = ((Math.random() * 0x7fffffff) | 0) || 1; await ctx.storage.put("seed", s); }
        this.seed = s;
      } catch (_) {
        this.saved = {}; this.mods = []; this.seed = this.seed || 1;
      }
      for (const [x, y, v, l] of this.mods)
        (l === 1 ? this.backModMap : this.modMap).set(x + "," + y, v);
      // Rebuild after waking from hibernation: sockets are still open,
      // reload their players from storage. lastSeen resets — an open
      // socket is proof of life.
      for (const ws of ctx.getWebSockets()) {
        const a = safeAttachment(ws);
        if (a && a.id) {
          const s = this.saved[a.id];
          this.players.set(a.id, {
            name: a.name,
            cid: a.cid,
            lastSeen: Date.now(),
            lastBreak: 0,
            lastPlace: 0,
            x: s ? s.x : this.spawn().x,
            y: s ? s.y : this.spawn().y,
          });
        }
      }
    });
  }

  spawn() {
    const x = WORLD.spawnX - 6 + Math.floor(Math.random() * 12);
    return { x, y: heightAt(this.seed, x) - PH - 0.05 };
  }

  effective(x, y) {
    const v = this.modMap.get(x + "," + y);
    return v === undefined ? tileAt(this.seed, x, y) : v;
  }

  effectiveBack(x, y) {
    const v = this.backModMap.get(x + "," + y);
    return v === undefined ? backAt(this.seed, x, y) : v;
  }

  inReach(p, x, y) {
    const dx = x + 0.5 - (p.x + PW / 2);
    const dy = y + 0.5 - (p.y + PH / 2);
    return dx * dx + dy * dy <= 5.8 * 5.8; // a little slack over WORLD.reach for lag
  }

  correct(ws, x, y, l = 0) { // tell one client the authoritative state of a tile
    const v = l === 1 ? this.effectiveBack(x, y) : this.effective(x, y);
    try { ws.send(JSON.stringify({ t: "b", x, y, v, l })); } catch (_) {}
  }

  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    const id = (url.searchParams.get("id") || "").slice(0, 64);
    const name = ((url.searchParams.get("name") || "player").trim() || "player").slice(0, 32);
    if (!id) return new Response("Missing id", { status: 400 });
    await this.ready;

    const pair = new WebSocketPair();
    const ws = pair[1];
    this.ctx.acceptWebSocket(ws);
    const cid = Math.random().toString(36).slice(2, 10);
    ws.serializeAttachment({ id, name, cid });

    // Returning player → back to their saved spot; new player → surface spawn.
    const s = this.saved[id];
    const start = s ? { x: s.x, y: s.y } : this.spawn();
    this.players.set(id, { name, cid, lastSeen: Date.now(), lastBreak: 0, lastPlace: 0, x: start.x, y: start.y });

    const roster = {};
    for (const [pid, p] of this.players) roster[pid] = { name: p.name, x: p.x, y: p.y };
    ws.send(JSON.stringify({
      t: "init", you: id, world: WORLD, seed: this.seed, players: roster,
      mods: this.mods.length > 50000 ? this.mods.slice(-50000) : this.mods,
    }));
    this.broadcast({ t: "+", id, name, x: start.x, y: start.y }, id);
    this.scheduleSave();

    // Arm the liveness sweeper (an alarm wakes the room even if hibernated).
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    const a = safeAttachment(ws);
    if (!a || !a.id) return;
    const p = this.players.get(a.id);
    if (!p || p.cid !== a.cid) return; // stale socket from an older session
    p.lastSeen = Date.now(); // any message proves the client is alive

    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.t === "hb") return; // heartbeat: presence only, no relay

    if (m.t === "p" && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      p.x = clamp(m.x, 0, WORLD.w - PW);
      p.y = clamp(m.y, -500, WORLD.h - PH);
      this.broadcast({ t: "p", id: a.id, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }, a.id);
      this.scheduleSave();

    } else if (m.t === "dig") {
      const x = m.x | 0, y = m.y | 0, l = m.l === 1 ? 1 : 0;
      if (x < 0 || y < 0 || x >= WORLD.w || y >= WORLD.h) return;
      if (l === 1) {
        // back layer: placed walls & tree trunks dig out (trunks = the wood
        // supply); natural terrain walls are permanent
        const bv = this.effectiveBack(x, y);
        if (bv === T_AIR || bv === T_BEDROCK || bv === T_LAVA || !this.inReach(p, x, y)) { this.correct(ws, x, y, 1); return; }
        if (!this.backModMap.has(x + "," + y) && bv !== T_WOOD) { this.correct(ws, x, y, 1); return; }
        const now = Date.now();
        if (now - p.lastBreak < (HARD[bv] || 1) * 800) { this.correct(ws, x, y, 1); return; } // too fast
        p.lastBreak = now;
        this.setTile(x, y, T_AIR, 1);
        this.broadcast({ t: "b", x, y, v: T_AIR, l: 1 });
        return;
      }
      const v = this.effective(x, y);
      if (v === T_AIR || v === T_BEDROCK || v === T_LAVA || !this.inReach(p, x, y)) { this.correct(ws, x, y, 0); return; }
      const now = Date.now();
      if (now - p.lastBreak < (HARD[v] || 1) * 800) { this.correct(ws, x, y, 0); return; } // too fast
      p.lastBreak = now;
      this.setTile(x, y, T_AIR, 0);
      this.broadcast({ t: "b", x, y, v: T_AIR, l: 0 });

    } else if (m.t === "place") {
      const x = m.x | 0, y = m.y | 0, v = m.v | 0, l = m.l === 1 ? 1 : 0;
      if (x < 0 || y < 0 || x >= WORLD.w || y >= WORLD.h) return;
      if (!PLACEABLE[v]) return;
      if (l === 1) {
        // back wall: any empty back cell; walk-through, so no entomb check
        if (this.effectiveBack(x, y) !== T_AIR) { this.correct(ws, x, y, 1); return; }
        if (!this.inReach(p, x, y)) { this.correct(ws, x, y, 1); return; }
        const now = Date.now();
        if (now - p.lastPlace < 160) { this.correct(ws, x, y, 1); return; } // too fast
        p.lastPlace = now;
        this.setTile(x, y, v, 1);
        this.broadcast({ t: "b", x, y, v, l: 1 });
        return;
      }
      if (this.effective(x, y) !== T_AIR) { this.correct(ws, x, y, 0); return; }
      if (!this.inReach(p, x, y)) { this.correct(ws, x, y, 0); return; }
      const now = Date.now();
      if (now - p.lastPlace < 160) { this.correct(ws, x, y, 0); return; } // too fast
      for (const pl of this.players.values()) { // never entomb a player
        if (x < pl.x + PW && x + 1 > pl.x && y < pl.y + PH && y + 1 > pl.y) { this.correct(ws, x, y, 0); return; }
      }
      p.lastPlace = now;
      this.setTile(x, y, v, 0);
      this.broadcast({ t: "b", x, y, v, l: 0 });
    }
  }

  setTile(x, y, v, l = 0) {
    (l === 1 ? this.backModMap : this.modMap).set(x + "," + y, v);
    this.mods.push([x, y, v, l]);
    this.scheduleSave();
  }

  // Liveness sweeper. Runs every SWEEP_MS while anyone is connected;
  // an alarm wakes the room even if it hibernated.
  async alarm() {
    const now = Date.now();
    for (const [id, p] of [...this.players]) {
      if (now - p.lastSeen > STALE_MS) {
        this.saved[id] = { name: p.name, x: p.x, y: p.y };
        this.players.delete(id);
        for (const ws of this.ctx.getWebSockets()) {
          const a = safeAttachment(ws);
          if (a && a.id === id) { try { ws.close(4000, "idle"); } catch (_) {} }
        }
        this.broadcast({ t: "-", id }, id);
      }
    }
    this.scheduleSave();
    if (this.players.size > 0) {
      await this.ctx.storage.setAlarm(now + SWEEP_MS);
    }
  }

  async webSocketClose(ws) { this.drop(ws); }
  async webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const a = safeAttachment(ws);
    if (!a || !a.id) return;
    const p = this.players.get(a.id);
    if (!p || p.cid !== a.cid) return; // already re-joined on a newer socket
    this.saved[a.id] = { name: p.name, x: p.x, y: p.y };
    this.players.delete(a.id);
    this.broadcast({ t: "-", id: a.id }, a.id);
    this.scheduleSave();
    try { ws.close(); } catch (_) {}
  }

  broadcast(msg, exceptId) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const a = safeAttachment(ws);
      if (a && a.id && a.id !== exceptId) {
        try { ws.send(s); } catch (_) { this.drop(ws); } // dead socket → remove ghost now
      }
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      const merged = { ...this.saved };
      for (const [id, p] of this.players) {
        merged[id] = { name: p.name, x: p.x, y: p.y };
      }
      this.saved = merged;
      try {
        await this.ctx.storage.put("saved", merged);
        await this.ctx.storage.put("mods", this.mods);
      } catch (_) {}
    }, 1500);
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function safeAttachment(ws) {
  try { return ws.deserializeAttachment(); } catch (_) { return null; }
}
