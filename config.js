// ═══════════════════════════════════════════════════════════════════
//  Voice Room — YOUR CONFIG
//
//  This is the ONLY file you ever edit by hand. Fill in the two values
//  after finishing Parts 1 and 2 of the Setup Guide, then upload it to
//  your GitHub repo next to index.html.
//
//  Future updates (like the game) replace index.html only — keep this
//  file and your settings survive every update.
// ═══════════════════════════════════════════════════════════════════

window.APP_CONFIG = {
  // From Part 2 — your Cloudflare Worker address (no trailing slash).
  // Looks like:  https://voice-room.YOURNAME.workers.dev
  WORKER_URL: "https://artemswebgameworker.bokhrenkovr.workers.dev",
    //"https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev",

  // From Part 1 — your LiveKit project URL.
  // Looks like:  wss://your-project-abc123.livekit.cloud
  LIVEKIT_URL: "wss://artemswebgame-ndmnp9un.livekit.cloud",
    //"wss://YOUR-PROJECT.livekit.cloud",
};
