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
//  The Durable Object is the authoritative game room: it tracks every
//  player's position, relays updates to the others, and SAVES positions
//  to its built-in storage — so the world survives everyone leaving and
//  is restored when someone re-enters. Nobody is ever "host".
// ═══════════════════════════════════════════════════════════════════

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ROOM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// World constants — single source of truth. The Durable Object sends
// this to every client in the "init" message, so the world is identical
// for everyone (and matches the proximity-voice range: hear = 20 blocks).
const WORLD = {
  w: 4800,        // world width in px — a few screens wide
  h: 800,         // world height in px (vertical fits the screen)
  block: 40,      // player block size
  floorTop: 680,  // y of the floor surface
  hear: 800,      // proximity voice range = 20 player widths
  spawnMin: 200,  // random spawn x in [spawnMin, spawnMin+spawnSpan]
  spawnSpan: 500, // < hear range, so everyone always spawns within earshot
};

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
//  Client → here:   { t:"p", x, y }            position update
//  Here → client:   { t:"init", you, world, players }   on join
//                   { t:"+", id, name, x, y }   someone joined
//                   { t:"p", id, x, y }         someone moved
//                   { t:"-", id }               someone left
//
//  Positions persist in SQLite storage ("saved"): when everyone leaves
//  the room keeps their spots, and re-entering later puts you back
//  where you were.
// ═══════════════════════════════════════════════════════════════════

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.players = new Map(); // connected: id -> { name, x, y, cid }
    this.saved = {};          // persisted:  id -> { name, x, y }
    this.saveTimer = null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      try {
        this.saved = (await ctx.storage.get("saved")) || {};
      } catch (_) {
        this.saved = {};
      }
      // Rebuild after waking from hibernation: sockets are still open,
      // reload their players from storage.
      for (const ws of ctx.getWebSockets()) {
        const a = safeAttachment(ws);
        if (a && a.id) {
          const s = this.saved[a.id];
          this.players.set(a.id, {
            name: a.name,
            cid: a.cid,
            x: s ? s.x : spawnX(),
            y: s ? s.y : WORLD.floorTop - WORLD.block,
          });
        }
      }
    });
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

    // Returning player → back to their saved spot; new player → random spawn.
    const s = this.saved[id];
    const start = {
      x: s ? s.x : spawnX(),
      y: s ? s.y : WORLD.floorTop - WORLD.block,
    };
    this.players.set(id, { name, cid, x: start.x, y: start.y });

    const roster = {};
    for (const [pid, p] of this.players) roster[pid] = { name: p.name, x: p.x, y: p.y };
    ws.send(JSON.stringify({ t: "init", you: id, world: WORLD, players: roster }));
    this.broadcast({ t: "+", id, name, x: start.x, y: start.y }, id);
    this.scheduleSave();

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    const a = safeAttachment(ws);
    if (!a || !a.id) return;
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }

    if (m.t === "p" && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      const p = this.players.get(a.id);
      if (!p || p.cid !== a.cid) return; // stale socket from an older session
      p.x = clamp(m.x, 0, WORLD.w - WORLD.block);
      p.y = clamp(m.y, -4000, 4000);
      this.broadcast({ t: "p", id: a.id, x: Math.round(p.x), y: Math.round(p.y) }, a.id);
      this.scheduleSave();
    }
  }

  async webSocketClose(ws) { this.drop(ws); }
  async webSocketError(ws) { this.drop(ws); }

  drop(ws) {
    const a = safeAttachment(ws);
    if (!a || !a.id) return;
    const p = this.players.get(a.id);
    if (!p || p.cid !== a.cid) return; // already re-joined on a newer socket
    this.saved[a.id] = { name: p.name, x: Math.round(p.x), y: Math.round(p.y) };
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
        try { ws.send(s); } catch (_) {}
      }
    }
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      const merged = { ...this.saved };
      for (const [id, p] of this.players) {
        merged[id] = { name: p.name, x: Math.round(p.x), y: Math.round(p.y) };
      }
      this.saved = merged;
      try { await this.ctx.storage.put("saved", merged); } catch (_) {}
    }, 1500);
  }
}

function spawnX() {
  return WORLD.spawnMin + Math.floor(Math.random() * WORLD.spawnSpan);
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function safeAttachment(ws) {
  try { return ws.deserializeAttachment(); } catch (_) { return null; }
}
