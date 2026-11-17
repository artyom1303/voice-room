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
//     { t:"inv", s:{m,b} }          my inventory (step 14), saved under my TYPED NAME; m = ribbon [[item,count]…≤10], b = backpack or null
//     { t:"hb" }                    heartbeat, every 5 s
//  Server → client:
//     { t:"init", id, seed, spawnX, players:{id:{name,x,y}}, inv:{m,b}|null, more, edits:[x,y,l,b, x,y,l,b, …] }
//     { t:"eb", edits:[…] }          `more` further slices of the edit list, sent straight after init
//     { t:"+", id, name, x, y }     someone joined        { t:"-", id }    someone left
//     { t:"p", id, x, y }           someone moved         { t:"e", x, y, l, b, by }   an accepted edit, `by` = who made it
//
//  SAVING (step 7). The edit list is kept in Durable Object storage, grouped by 32×32 chunk
//  (key "c:<cx>:<cy>" → flat [x,y,l,b,…]), plus {seed} under "meta". Changed chunks are written
//  about 1 s after the last edit, and immediately when the last player leaves. On wake-up the room
//  loads everything BEFORE it accepts a connection, and never writes until that load succeeded, so a
//  failed load can't overwrite a good save. A failed write keeps the chunk marked dirty and retries.
//  Worst case (the server dies) you lose the last second of building. Works with KV- or SQLite-backed DOs.
//
//  INVENTORIES (step 14). Progress belongs to the typed name, not to the connection: key "i:<name>" (lower-cased,
//  spaces squeezed) → {m,b}. The page reads it once from `init` and sends the whole inventory back whenever it
//  changes (about once a second). Anything malformed is ignored; at most MAX_INVS names per room.
//
//  TERRAIN VERSION. "meta" also carries w = WORLD_V. When it differs, only the saved edits (c: records) are dropped; inventories stay.
//
//  DATA VERSION. "meta" carries v = DATA_V. If the stored version is missing or different, everything stored
//  for the room is deleted once (deploying step 14 starts every world fresh: "version 0.0").
// ═══════════════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// World limits. MUST match world.js (W, H) and edit.js (LOCKED_ROWS).
const W = 10016, H = 2016;
const UNDER = 1500;           // players may fly (ghost mode) this far below the world, into the magma. MUST match world.js UNDER
const LOCKED_ROWS = 4;        // bottom rows can never be edited
const BODY_CX = 0.3, BODY_CY = 0.9;   // centre of the player's 0.6 × 1.8 box. MUST match player.js (PW/2, PH/2)
const BEDROCK = 7;            // can never be placed
const MAX_BLOCK = 10;         // 0 = removed, 1..6 = grass dirt stone coal iron gold; 7 (bedrock) is never placeable; 8..10 = log leaves planks
const EDIT_REACH = 9;         // tiles. Clients enforce 5.5; this is the slack for lag
const EDIT_RATE = 40;         // edits per second a player may sustain …
const EDIT_BURST = 80;        // … with this much burst
const MAX_MSG = 512;          // client messages are tiny; anything bigger is junk
const MAX_INV_MSG = 2048;     // ...except an inventory (ribbon + 8×8 backpack)
const DATA_V = 2;             // saved-data version; a different stored version is wiped on load (step 14 = fresh start)
const WORLD_V = 3;            // terrain version (step 18: rock layers). A different one drops the saved EDITS only (they would be in the wrong place on new terrain); inventories stay
const MAX_INVS = 100;         // saved inventories per room (a room is for ≤5 friends; this only stops name spam)
const INV_BURST = 10, INV_RATE = 2;   // inventory messages per player: 10 at once, 2 per second sustained
const MAIN_SLOTS = 10, BAG_SLOTS = 64, STACK_MAX = 99, MAX_ITEM_ID = 255;   // MUST match items.js
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

// the key a player's progress is saved under: their typed name, case and spacing ignored
function nameKey(name) {
  return String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 32) || "player";
}
// the same rules as Items.sanitize in items.js (ids only need to be in range here: the server doesn't know the item list)
function cleanInv(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.m) || raw.m.length > MAIN_SLOTS) return null;
  const stack = (s) => {
    if (!Array.isArray(s) || s.length !== 2) return null;
    const id = s[0], n = s[1];
    if (!Number.isInteger(id) || id < 1 || id > MAX_ITEM_ID || !Number.isInteger(n) || n < 1 || n > STACK_MAX) return null;
    return [id, n];
  };
  const m = [];
  for (const s of raw.m) { const c = stack(s); if (!c) return null; m.push(c); }
  let b = null;
  if (raw.b !== null && raw.b !== undefined) {
    if (!Array.isArray(raw.b) || raw.b.length !== BAG_SLOTS) return null;
    b = [];
    for (const s of raw.b) { if (s === null) { b.push(null); continue; } const c = stack(s); if (!c) return null; b.push(c); }
  }
  return { m, b };
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
    this.invs = new Map();        // name key -> { m, b }  saved inventories
    this.invDirty = new Set();    // name keys changed since they were last saved
    this.metaPending = false;     // true while the "meta" record (data version + seed) has still to be written
    this.loadedOk = !this.storage;                               // writes are allowed only after a successful load
    this.loaded = this.storage
      ? (ctx.blockConcurrencyWhile ? ctx.blockConcurrencyWhile(() => this.load()) : this.load())
      : Promise.resolve();
  }

  // ── saving ────────────────────────────────────────────────────
  async load() {
    const meta = await this.storage.get("meta");
    if (!meta || meta.v !== DATA_V) {                              // old (or no) data version: start the room fresh. Only reached after a successful read.
      await this.storage.deleteAll();
      this.loadedOk = true;
      return;
    }
    if (Number.isInteger(meta.seed)) this.seed = meta.seed;
    const invs = await this.storage.list({ prefix: "i:" });
    for (const [k, v] of invs) { const c = cleanInv(v); if (c && this.invs.size < MAX_INVS) this.invs.set(k.slice(2), c); }
    if (meta.w !== WORLD_V) {                                      // terrain changed since this room was saved: forget the old edits, keep who has what
      const old = [...(await this.storage.list({ prefix: "c:" })).keys()];
      for (let i = 0; i < old.length; i += 100) await this.storage.delete(old.slice(i, i + 100));
      this.metaPending = true;                                     // the new terrain version is written before anything else
      this.loadedOk = true;
      return;
    }
    const saved = await this.storage.list({ prefix: "c:" });
    for (const [id, flat] of saved) {
      if (!Array.isArray(flat)) continue;
      for (let i = 0; i + 3 < flat.length; i += 4) {
        const x = flat[i], y = flat[i + 1], l = flat[i + 2], b = flat[i + 3];
        if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= W || y < 0 || y >= H - LOCKED_ROWS) continue;
        if ((l !== 0 && l !== 1) || !Number.isInteger(b) || b < 0 || b > MAX_BLOCK || b === BEDROCK) continue;   // skip anything corrupt
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

  hasDirty() { return this.dirty.size > 0 || this.invDirty.size > 0; }

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
      if (this.hasDirty()) this.scheduleFlush();                 // more edits arrived meanwhile, or a write failed: try again
    });
    return this.flushing;
  }
  async saveMeta() {                                             // the data-version record must be on disk before anything else is, or a later load would wipe the room
    if (!this.storage || !this.loadedOk || !this.metaPending || this.seed === null) return;
    try { await this.storage.put("meta", { v: DATA_V, w: WORLD_V, seed: this.seed }); this.metaPending = false; } catch (_) {}
  }
  async writeDirty() {
    await this.saveMeta();
    if (this.metaPending) return;                                // couldn't: everything stays dirty and is retried
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
    const keys = [...this.invDirty];
    this.invDirty.clear();
    try {
      for (let n = 0; n < keys.length; n += PUT_BATCH) {
        const batch = {};
        for (const k of keys.slice(n, n + PUT_BATCH)) batch["i:" + k] = this.invs.get(k);
        await this.storage.put(batch);
      }
    } catch (err) {
      for (const k of keys) this.invDirty.add(k);
      console.error("inventory save failed, will retry:", err && err.message);
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
      this.metaPending = true;
      await this.saveMeta();
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
    const key = nameKey(name);
    const p = { ws: server, name, key, x: spawnX, y: old ? old.y : null, lastSeen: now, tokens: EDIT_BURST, tokenT: now, invTokens: INV_BURST, invT: now };
    this.players.set(id, p);
    if (old) { try { old.ws.close(4001, "replaced"); } catch (_) {} }

    const roster = {};
    for (const [pid, q] of this.players) if (pid !== id) roster[pid] = { name: q.name, x: q.x, y: q.y };
    // the world's edits go out in slices: first slice inside init, the rest as {t:"eb"} messages right behind it
    const flat = this.flatEdits(), step = INIT_EDITS * 4, more = Math.max(0, Math.ceil(flat.length / step) - 1);
    server.send(JSON.stringify({ t: "init", id, seed: this.seed, spawnX: p.x, players: roster, inv: this.invs.get(key) || null, more, edits: flat.slice(0, step) }));
    for (let i = 1; i <= more; i++) server.send(JSON.stringify({ t: "eb", edits: flat.slice(i * step, (i + 1) * step) }));
    if (!old) this.broadcast({ t: "+", id, name, x: p.x, y: p.y }, id);

    server.addEventListener("message", (ev) => {
      if (this.players.get(id) !== p) return;           // a socket that was replaced
      p.lastSeen = Date.now();
      const raw = ev.data;
      if (typeof raw !== "string" || raw.length > MAX_INV_MSG) return;
      let m;
      try { m = JSON.parse(raw); } catch (_) { return; }
      if (!m || typeof m !== "object") return;
      if (m.t !== "inv" && raw.length > MAX_MSG) return;         // only an inventory may be bigger than a few hundred bytes
      if (m.t === "p") this.onPosition(id, p, m);
      else if (m.t === "e") this.onEdit(id, p, m);
      else if (m.t === "inv") this.onInventory(p, m);
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
    p.y = clamp(m.y, 0, H + UNDER);
    this.broadcast({ t: "p", id, x: p.x, y: p.y }, id);
  }

  onEdit(id, p, m) {
    const { x, y, l, b } = m;
    if (p.y === null) return;                                                   // no position yet: can't judge reach
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(l) || !Number.isInteger(b)) return;
    if (x < 0 || x >= W || y < 0 || y >= H - LOCKED_ROWS) return;              // outside the world / bedrock rows
    if (l !== 0 && l !== 1) return;
    if (b < 0 || b > MAX_BLOCK || b === BEDROCK) return;
    if (Math.hypot(x + 0.5 - (p.x + BODY_CX), y + 0.5 - (p.y + BODY_CY)) > EDIT_REACH) return;
    const now = Date.now();                                                     // token bucket
    p.tokens = Math.min(EDIT_BURST, p.tokens + ((now - p.tokenT) / 1000) * EDIT_RATE);
    p.tokenT = now;
    if (p.tokens < 1) return;
    p.tokens -= 1;

    const key = (y * W + x) * 2 + l;
    if (this.edits.get(key) === b) return;                                      // nothing new
    this.remember(key, b, true);
    this.broadcast({ t: "e", x, y, l, b, by: id });                             // everyone, sender included; `by` lets friends animate the swing
  }

  onInventory(p, m) {
    const c = cleanInv(m.s);
    if (!c) return;
    const now = Date.now();                                                     // token bucket, like edits
    p.invTokens = Math.min(INV_BURST, p.invTokens + ((now - p.invT) / 1000) * INV_RATE);
    p.invT = now;
    if (p.invTokens < 1) return;
    p.invTokens -= 1;
    const old = this.invs.get(p.key);
    if (!old && this.invs.size >= MAX_INVS) return;
    if (old && JSON.stringify(old) === JSON.stringify(c)) return;               // nothing new
    this.invs.set(p.key, c);
    this.invDirty.add(p.key);
    this.scheduleFlush();
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
    if (this.players.size === 0 && this.hasDirty()) this.flush();
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
