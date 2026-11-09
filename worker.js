// ═══════════════════════════════════════════════════════════════
//  Voice Room (minimal) — Cloudflare Worker + Durable Object
//
//  GET /health                 → sanity check
//  GET /token?room=…&name=…    → LiveKit join token
//  WS  /ws?room=…&name=…&id=…  → game room (one Durable Object per room)
//
//  Secrets:  LIVEKIT_API_KEY, LIVEKIT_API_SECRET
//  Binding:  ROOMS → class GameRoom   (same as before, wrangler.toml unchanged)
//
//  The server only relays player positions. No world, no saving.
// ═══════════════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const WORLD_W = 200;      // flat ground is 200 m wide
const SWEEP_MS = 10000;   // check for dead connections every 10 s
const STALE_MS = 30000;   // drop anyone silent for 30 s (client pings every 5 s)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/health") return json({ ok: true });
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
//  GameRoom — one per room name. Just remembers who is here and
//  where, and relays moves to everyone else.
//
//  Client → server:  { t:"p", x, y }   position
//                    { t:"hb" }         heartbeat
//  Server → client:  { t:"init", you, players }
//                    { t:"+", id, name, x, y }   joined
//                    { t:"p", id, x, y }         moved
//                    { t:"-", id }               left
// ═══════════════════════════════════════════════════════════════
export class GameRoom {
  constructor(ctx, env) {
    this.players = new Map(); // id -> { ws, name, x, y, lastSeen }
    this.timer = null;
  }

  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket")
      return new Response("Expected WebSocket", { status: 426 });

    const url = new URL(request.url);
    const id = (url.searchParams.get("id") || "").slice(0, 64);
    const name = ((url.searchParams.get("name") || "").trim() || "player").slice(0, 32);
    if (!id) return new Response("Missing id", { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    // same id reconnecting → kick the old socket
    const old = this.players.get(id);
    if (old) { try { old.ws.close(4001, "replaced"); } catch (_) {} }

    const p = { ws: server, name, x: WORLD_W / 2 - 4 + Math.random() * 8, y: -1, lastSeen: Date.now() };
    this.players.set(id, p);

    const roster = {};
    for (const [pid, q] of this.players) roster[pid] = { name: q.name, x: q.x, y: q.y };
    server.send(JSON.stringify({ t: "init", you: id, players: roster }));
    this.broadcast({ t: "+", id, name, x: p.x, y: p.y }, id);

    server.addEventListener("message", (ev) => {
      p.lastSeen = Date.now();
      let m;
      try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.t === "p" && Number.isFinite(m.x) && Number.isFinite(m.y)) {
        p.x = clamp(m.x, 0, WORLD_W - 1);
        p.y = clamp(m.y, -60, -1);
        this.broadcast({ t: "p", id, x: p.x, y: p.y }, id);
      }
    });

    const drop = () => {
      if (this.players.get(id) === p) { // ignore sockets that were replaced
        this.players.delete(id);
        this.broadcast({ t: "-", id });
      }
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    if (!this.timer) this.timer = setInterval(() => this.sweep(), SWEEP_MS);
    return new Response(null, { status: 101, webSocket: client });
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
