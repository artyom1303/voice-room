// ═══════════════════════════════════════════════════════════════
//  Voice Room — Cloudflare Worker + Durable Object   (step 6: shared block world)
//
//  GET /health                 → sanity check
//  GET /token?room=…&name=…    → LiveKit join token
//  WS  /ws?room=…&name=…&id=…  → game room (one Durable Object per room name)
//
//  Secrets:  LIVEKIT_API_KEY, LIVEKIT_API_SECRET
//  Binding:  ROOMS → class GameRoom        (same as before, wrangler.toml unchanged)
//
//  ONE FILE, NO IMPORTS: it works pasted into the dashboard or built by Wrangler.
//
//  The terrain itself is NOT generated here. Every client builds identical terrain from
//  the seed (world.js). The room only keeps:
//    • who is here and where,
//    • the list of block edits (mined / placed tiles), in the order they happened.
//  Edits are broadcast to EVERYONE, sender included, in server order, so all clients
//  end up with exactly the same world even when two people change the same tile at once.
//
//  Client → server (JSON):
//     { t:"p", x, y }               my position (tiles)
//     { t:"e", x, y, l, b }         edit: tile (x,y), layer l (0 front / 1 back), block b (0 = removed)
//     { t:"hb" }                    heartbeat, every 5 s
//  Server → client:
//     { t:"init", id, seed, spawnX, players:{id:{name,x,y}}, more, edits:[x,y,l,b, x,y,l,b, …] }
//     { t:"eb", edits:[…] }          `more` further slices of the edit list, sent straight after init
//     { t:"+", id, name, x, y }     someone joined        { t:"-", id }    someone left
//     { t:"p", id, x, y }           someone moved         { t:"e", x, y, l, b }   an accepted edit
//
//  SAVING (step 7). The edit list is kept in Durable Object storage, grouped by 32×32 chunk
//  (key "c:<cx>:<cy>" → flat [x,y,l,b,…]), plus {seed} under "meta". Changed chunks are written
//  about 1 s after the last edit, and immediately when the last player leaves. On wake-up the room
//  loads everything BEFORE it accepts a connection, and never writes until that load succeeded, so a
//  failed load can't overwrite a good save. A failed write keeps the chunk marked dirty and retries.
//  Worst case (the server dies) you lose the last second of building. Works with KV- or SQLite-backed DOs.
// ═══════════════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// World limits. MUST match world.js (W, H) and edit.js (LOCKED_ROWS).
const W = 10016, H = 2016;
const LOCKED_ROWS = 4;        // bottom rows can never be edited
const MAX_BLOCK = 6;          // 0 = removed, 1..6 = grass dirt stone coal iron gold; 7 (bedrock) is never placeable
const EDIT_REACH = 9;         // tiles. Clients enforce 5.5; this is the slack for lag
const EDIT_RATE = 40;         // edits per second a player may sustain …
const EDIT_BURST = 80;        // … with this much burst
const MAX_MSG = 512;          // client messages are tiny; anything bigger is junk
const SWEEP_MS = 10000;       // check for dead connections every 10 s
const STALE_MS = 30000;       // drop anyone silent for 30 s (clients ping every 5 s)
const FLUSH_MS = 1000;        // save changed chunks this long after the last edit
const CHUNK_SHIFT = 5;        // 32×32-tile save buckets (same as the renderer's chunks)
const PUT_BATCH = 100;        // storage.put accepts at most 128 keys at once
const INIT_EDITS = 4000;      // edits per message when sending the world to a joiner (a WebSocket message may not exceed 1 MiB)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health") return json({ ok: true, game: !!env.ROOMS });
    if (url.pathname === "/token") return handleToken(url, env);

    if (url.pathname === "/ws") {
      if (!env.ROOMS) return json({ error: "ROOMS Durable Object binding missing" }, 501);
      const room = (url.searchParams.get("room") || "").toLowerCase().trim();
      if (!ROOM_RE.test(room)) return json({ error: "Invalid room name" }, 400);
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
    }
    return json({ error: "Not found" }, 404);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// same room name -> same world, every time
function seedFromRoom(room) {
  let h = 0x811c9dc5;
  for (let i = 0; i < room.length; i++) { h ^= room.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h | 0;
}

// ── LiveKit token ───────────────────────────────────────────────
async function handleToken(url, env) {
  const room = (url.searchParams.get("room") || "").toLowerCase().trim();
  const name = (url.searchParams.get("name") || "").trim().slice(0, 32);
  if (!ROOM_RE.test(room)) return json({ error: "Invalid room name" }, 400);
  if (!name) return json({ error: "Please enter a name." }, 400);
  if (!env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET)
    return json({ error: "Server missing LiveKit secrets." }, 500);

  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, "") || "user";
  const identity = `${slug}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt({
    iss: env.LIVEKIT_API_KEY,
    sub: identity,
    name,
    iat: now,
    nbf: now - 10,
    exp: now + 6 * 60 * 60,
    video: { roomJoin: true, room, canPublish: true, canSubscribe: true },
  }, env.LIVEKIT_API_SECRET);
  return json({ token });
}

async function signJwt(payload, secret) {
  const data = b64text(JSON.stringify({ alg: "HS256", typ: "JWT" })) + "." + b64text(JSON.stringify(payload));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return data + "." + b64bytes(new Uint8Array(sig));
}
function b64text(s) { return b64bytes(new TextEncoder().encode(s)); }
function b64bytes(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ═══════════════════════════════════════════════════════════════
//  GameRoom — one per room name
// ═══════════════════════════════════════════════════════════════
export class GameRoom {
  constructor(ctx, env) {
    this.storage = (ctx && ctx.storage) || null;                 // absent in plain tests: then the room is memory-only
    this.players = new Map();   // id -> { ws, name, x, y (null until first position), lastSeen, tokens, tokenT }
    this.edits = new Map();     // (y*W + x)*2 + layer  ->  block id, in the order first edited
    this.seed = null;
    this.timer = null;
    this.chunkTiles = new Map();  // chunk id -> Set of edit keys inside it (to rewrite a chunk without scanning everything)
    this.dirty = new Set();       // chunk ids that changed since they were last saved
    this.flushTimer = null;
    this.flushing = null;         // promise of the write in progress
    this.loadedOk = !this.storage;                               // writes are allowed only after a successful load
    this.loaded = this.storage
      ? (ctx.blockConcurrencyWhile ? ctx.blockConcurrencyWhile(() => this.load()) : this.load())
      : Promise.resolve();
  }

  // ── saving ────────────────────────────────────────────────────
  async load() {
    const meta = await this.storage.get("meta");
    if (meta && Number.isInteger(meta.seed)) this.seed = meta.seed;
    const saved = await this.storage.list({ prefix: "c:" });
    for (const [id, flat] of saved) {
      if (!Array.isArray(flat)) continue;
      for (let i = 0; i + 3 < flat.length; i += 4) {
        const x = flat[i], y = flat[i + 1], l = flat[i + 2], b = flat[i + 3];
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= W || y < 0 || y >= H - LOCKED_ROWS) continue;
        if ((l !== 0 && l !== 1) || !Number.isInteger(b) || b < 0 || b > MAX_BLOCK) continue;   // skip anything corrupt
        this.remember((y * W + x) * 2 + l, b, false);
      }
    }
    this.loadedOk = true;
  }

  remember(key, b, markDirty) {                                  // one place that records an edit
    this.edits.set(key, b);
    const i = key >> 1, cid = `c:${(i % W) >> CHUNK_SHIFT}:${((i / W) | 0) >> CHUNK_SHIFT}`;
    let set = this.chunkTiles.get(cid);
    if (!set) this.chunkTiles.set(cid, (set = new Set()));
    set.add(key);
    if (markDirty) { this.dirty.add(cid); this.scheduleFlush(); }
  }

  scheduleFlush() {
    if (!this.storage || this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, FLUSH_MS);
  }

  // writes every dirty chunk; safe to call any time (concurrent calls share one write)
  flush() {
    if (!this.storage || !this.loadedOk) return Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = this.writeDirty().finally(() => {
      this.flushing = null;
      if (this.dirty.size) this.scheduleFlush();                 // more edits arrived meanwhile, or a write failed: try again
    });
    return this.flushing;
  }
  async writeDirty() {
    const ids = [...this.dirty];
    this.dirty.clear();
    try {
      for (let n = 0; n < ids.length; n += PUT_BATCH) {
        const batch = {};
        for (const cid of ids.slice(n, n + PUT_BATCH)) {
          const flat = [];
          for (const key of this.chunkTiles.get(cid)) { const i = key >> 1; flat.push(i % W, (i / W) | 0, key & 1, this.edits.get(key)); }
          batch[cid] = flat;
        }
        await this.storage.put(batch);
      }
    } catch (err) {
      for (const cid of ids) this.dirty.add(cid);                // nothing is lost: they stay dirty and are retried
      console.error("save failed, will retry:", err && err.message);
    }
  }

  async fetch(request) {
    await this.loaded;
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });

    const url = new URL(request.url);
    const room = (url.searchParams.get("room") || "").toLowerCase().trim();
    const id = (url.searchParams.get("id") || "").slice(0, 64);
    const name = ((url.searchParams.get("name") || "").trim() || "player").slice(0, 32);
    if (!id) return new Response("Missing id", { status: 400 });
    if (this.seed === null) {
      this.seed = seedFromRoom(room);
      if (this.storage && this.loadedOk) { try { await this.storage.put("meta", { v: 1, seed: this.seed }); } catch (_) {} }
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const now = Date.now();
    const old = this.players.get(id);                   // same id again = a reconnect: keep their place
    let spawnX;
    if (old) spawnX = old.x;
    else {
      const placed = [...this.players.values()].filter((q) => q.y !== null);
      spawnX = placed.length                            // spawn next to a friend, or at the world centre
        ? clamp(placed[Math.floor(Math.random() * placed.length)].x + (Math.random() - 0.5) * 4, 0, W - 1)
        : W / 2 - 4 + Math.random() * 8;
    }
    const p = { ws: server, name, x: spawnX, y: old ? old.y : null, lastSeen: now, tokens: EDIT_BURST, tokenT: now };
    this.players.set(id, p);
    if (old) { try { old.ws.close(4001, "replaced"); } catch (_) {} }

    const roster = {};
    for (const [pid, q] of this.players) if (pid !== id) roster[pid] = { name: q.name, x: q.x, y: q.y };
    // the world's edits go out in slices: first slice inside init, the rest as {t:"eb"} messages right behind it
    const flat = this.flatEdits(), step = INIT_EDITS * 4, more = Math.max(0, Math.ceil(flat.length / step) - 1);
    server.send(JSON.stringify({ t: "init", id, seed: this.seed, spawnX: p.x, players: roster, more, edits: flat.slice(0, step) }));
    for (let i = 1; i <= more; i++) server.send(JSON.stringify({ t: "eb", edits: flat.slice(i * step, (i + 1) * step) }));
    if (!old) this.broadcast({ t: "+", id, name, x: p.x, y: p.y }, id);

    server.addEventListener("message", (ev) => {
      if (this.players.get(id) !== p) return;           // a socket that was replaced
      p.lastSeen = Date.now();
      const raw = ev.data;
      if (typeof raw !== "string" || raw.length > MAX_MSG) return;
      let m;
      try { m = JSON.parse(raw); } catch (_) { return; }
      if (!m || typeof m !== "object") return;
      if (m.t === "p") this.onPosition(id, p, m);
      else if (m.t === "e") this.onEdit(p, m);
    });

    const drop = () => {
      if (this.players.get(id) === p) {                 // ignore sockets that were replaced
        this.players.delete(id);
        this.broadcast({ t: "-", id });
        if (this.players.size === 0) this.flush();               // last one out: save right now
      }
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    if (!this.timer) this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  onPosition(id, p, m) {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) return;
    p.x = clamp(m.x, 0, W - 1);
    p.y = clamp(m.y, 0, H - 1);
    this.broadcast({ t: "p", id, x: p.x, y: p.y }, id);
  }

  onEdit(p, m) {
    const { x, y, l, b } = m;
    if (p.y === null) return;                                                   // no position yet: can't judge reach
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(l) || !Number.isInteger(b)) return;
    if (x < 0 || x >= W || y < 0 || y >= H - LOCKED_ROWS) return;              // outside the world / bedrock rows
    if (l !== 0 && l !== 1) return;
    if (b < 0 || b > MAX_BLOCK) return;
    if (Math.hypot(x + 0.5 - (p.x + 0.45), y + 0.5 - (p.y + 0.45)) > EDIT_REACH) return;
    const now = Date.now();                                                     // token bucket
    p.tokens = Math.min(EDIT_BURST, p.tokens + ((now - p.tokenT) / 1000) * EDIT_RATE);
    p.tokenT = now;
    if (p.tokens < 1) return;
    p.tokens -= 1;

    const key = (y * W + x) * 2 + l;
    if (this.edits.get(key) === b) return;                                      // nothing new
    this.remember(key, b, true);
    this.broadcast({ t: "e", x, y, l, b });                                     // everyone, sender included
  }

  flatEdits() {
    const out = [];
    for (const [k, b] of this.edits) { const i = k >> 1; out.push(i % W, (i / W) | 0, k & 1, b); }
    return out;
  }

  sweep() {
    const now = Date.now();
    for (const [id, p] of [...this.players]) {
      if (now - p.lastSeen > STALE_MS) {
        this.players.delete(id);
        try { p.ws.close(4000, "idle"); } catch (_) {}
        this.broadcast({ t: "-", id });
      }
    }
    if (this.players.size === 0 && this.dirty.size) this.flush();
    if (this.players.size === 0 && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  broadcast(msg, exceptId) {
    const s = JSON.stringify(msg);
    for (const [id, p] of this.players) {
      if (id === exceptId) continue;
      try { p.ws.send(s); } catch (_) {}
    }
  }
}
