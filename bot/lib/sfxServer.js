const fs = require("fs");
const path = require("path");
const express = require("express");
const { SFX_DIR } = require("./paths");
const { SFX_SERVER_PORT } = require("./env");
const songSettingsStore = require("./persistence/songSettings");

const ALIGN_VALUES = new Set(["left", "center", "right"]);
// Defends against a hand-edited/corrupted songRequestSettings.json — this
// value gets interpolated directly into the served overlay HTML below, so
// an unrecognized value is dropped to the default rather than trusted as-is.
function safeAlign(value) {
  return ALIGN_VALUES.has(value) ? value : "left";
}

/* ------------------------------------------------------------------ */
/* Tiny local HTTP server whose only job is feeding OBS Browser         */
/* Sources — the SFX overlay, the Now Playing overlay, and the Wordle    */
/* game board, since they're all exactly the same local-server-for-OBS   */
/* infrastructure. All three use the same one-directional                */
/* server-sent-events approach: the browser source loads its page once   */
/* and keeps an SSE connection open, and we push it updates as they      */
/* happen. No websocket lib needed — SSE is all a one-way push like       */
/* this needs, and Chromium (what OBS's browser source runs) supports    */
/* it natively. The Wordle overlay is served from a real file            */
/* (lib/wordleOverlay.html) rather than an inline template string like   */
/* the other two below — it's a few hundred lines of ported CSS/JS,       */
/* big enough that embedding it here would make this file unwieldy and   */
/* the ported script leans on JS template literals that would clash      */
/* with being nested inside this file's own.                            */
/*                                                                     */
/* SFX_DIR is a fixed folder next to the app (see lib/paths.js) — files */
/* land there via the Tauri "import_sfx_file" command, which copies     */
/* whatever the user picks from anywhere on disk into it, so this never */
/* has to deal with an arbitrary/unwritable source location.            */
/*                                                                     */
/* All three overlays are opt-in by nature — the server just serves the  */
/* routes, nothing happens unless the user actually adds the URL as an   */
/* OBS Browser Source, same reasoning as the SFX overlay always running   */
/* whether or not anyone's added it.                                    */
/* ------------------------------------------------------------------ */

const app = express();
const clients = new Set();
const nowPlayingClients = new Set();
const wordleClients = new Set();
let lastNowPlaying = null;

app.use("/files", express.static(SFX_DIR));

app.get("/overlay", (req, res) => {
  res.type("html").send(OVERLAY_HTML);
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

app.get("/nowplaying", (req, res) => {
  res.type("html").send(renderNowPlayingHtml());
});

app.get("/nowplaying-events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  nowPlayingClients.add(res);
  // Send whatever's already known immediately, so a freshly-opened OBS
  // browser source doesn't sit empty until the next 3s poll tick.
  res.write(`data: ${JSON.stringify({ type: "track", data: lastNowPlaying })}\n\n`);
  res.write(
    `data: ${JSON.stringify({ type: "settings", data: { align: safeAlign(songSettingsStore.settings.nowPlayingAlign) } })}\n\n`
  );
  req.on("close", () => nowPlayingClients.delete(res));
});

app.get("/wordle", (req, res) => {
  res.sendFile(path.join(__dirname, "wordleOverlay.html"));
});

app.get("/wordle-events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  wordleClients.add(res);
  // Lazy require — dodges caring which of sfxServer.js/games/wordle.js bot.js
  // happens to require first. Sends the current board immediately, same
  // reasoning as the Now Playing snapshot above, so switching OBS scenes
  // mid-round doesn't show a blank board until the next guess.
  res.write(`data: ${JSON.stringify(require("./games/wordle").getSnapshot())}\n\n`);
  req.on("close", () => wordleClients.delete(res));
});

const OVERLAY_HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>SFX overlay</title></head>
<body style="margin:0;background:transparent;overflow:hidden;">
<script>
  // Every triggered sound goes on this queue and plays one at a time, back
  // to back — nothing is ever dropped for arriving close together (several
  // redemptions landing in the same second, say), and they don't overlap
  // into a garbled mess either. A failed file (bad playback, missing file)
  // just gets skipped so it can't wedge everything queued behind it.
  const queue = [];
  let playing = false;

  function playNext() {
    if (playing) return;
    const item = queue.shift();
    if (!item) return;

    playing = true;
    const audio = new Audio("/files/" + encodeURIComponent(item.file));
    // volume arrives as 0-100 from the redeem/command's own setting; Audio
    // wants 0-1. Clamped here too in case something odd ends up on the wire.
    audio.volume = Math.min(100, Math.max(0, item.volume ?? 100)) / 100;
    const advance = () => { playing = false; playNext(); };
    audio.addEventListener("ended", advance);
    audio.addEventListener("error", advance);
    audio.play().catch((err) => {
      console.error("[SFX overlay] playback failed:", err);
      advance();
    });
  }

  const es = new EventSource("/events");
  es.onmessage = (e) => {
    queue.push(JSON.parse(e.data));
    playNext();
  };
</script>
</body>
</html>`;

function renderNowPlayingHtml() {
  return NOWPLAYING_HTML_TEMPLATE.replace(
    "__ALIGN__",
    safeAlign(songSettingsStore.settings.nowPlayingAlign)
  );
}

const NOWPLAYING_HTML_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Now Playing overlay</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; overflow: hidden; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex;
    align-items: flex-end;
    width: 100vw;
    height: 100vh;
    padding: 24px;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  body[data-align="left"] { justify-content: flex-start; }
  body[data-align="center"] { justify-content: center; }
  body[data-align="right"] { justify-content: flex-end; }
  #card {
    display: flex;
    align-items: center;
    gap: 14px;
    max-width: 420px;
    padding: 12px 16px;
    border-radius: 14px;
    background: rgba(15, 14, 24, 0.78);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border: 1px solid rgba(139, 92, 246, 0.3);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
    opacity: 0;
    transform: translateY(12px);
    transition: opacity 0.4s ease, transform 0.4s ease;
  }
  #card.show { opacity: 1; transform: translateY(0); }
  #art {
    width: 52px;
    height: 52px;
    border-radius: 8px;
    object-fit: cover;
    background: rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
  }
  #text { min-width: 0; color: #ede9fe; }
  #title {
    font-size: 15px;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #artist {
    font-size: 12.5px;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-top: 2px;
  }
  #barTrack {
    margin-top: 6px;
    height: 3px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.15);
    overflow: hidden;
  }
  #barFill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #8b5cf6, #c4b5fd);
    border-radius: 3px;
  }
</style>
</head>
<body data-align="__ALIGN__">
<div id="card">
  <img id="art" alt="">
  <div id="text">
    <div id="title"></div>
    <div id="artist"></div>
    <div id="barTrack"><div id="barFill"></div></div>
  </div>
</div>
<script>
  const card = document.getElementById("card");
  const art = document.getElementById("art");
  const title = document.getElementById("title");
  const artist = document.getElementById("artist");
  const barFill = document.getElementById("barFill");

  function render(now) {
    if (!now || !now.title) {
      card.classList.remove("show");
      return;
    }

    art.src = now.albumArt || "";
    art.style.visibility = now.albumArt ? "visible" : "hidden";
    title.textContent = now.title;
    artist.textContent = now.artist || "";
    card.classList.add("show");

    const pct = now.durationMs ? Math.min(100, (now.progressMs / now.durationMs) * 100) : 0;
    barFill.style.transition = "none";
    barFill.style.width = pct + "%";

    if (now.isPlaying && now.durationMs) {
      const remainingMs = Math.max(0, now.durationMs - now.progressMs);
      // Force reflow so the transition below animates from the instant
      // width set above, not from 0% — gives a smooth continuous bar
      // between 3s poll updates instead of a jump every tick.
      void barFill.offsetWidth;
      barFill.style.transition = "width " + remainingMs + "ms linear";
      barFill.style.width = "100%";
    }
  }

  const es = new EventSource("/nowplaying-events");
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "settings") {
      document.body.dataset.align = msg.data.align || "left";
    } else {
      render(msg.data);
    }
  };
</script>
</body>
</html>`;

// Pushes a "play this file" event to every connected SFX overlay. `volume`
// is 0-100 (a redeem/command's own sfxVolume setting), defaulting to full
// volume for any caller that doesn't pass one. Returns how many overlays
// actually received it, mainly so callers can notice if nobody's browser
// source is even open yet.
function playFile(filename, volume = 100) {
  const payload = JSON.stringify({ file: filename, volume });
  for (const res of clients) {
    res.write(`data: ${payload}\n\n`);
  }
  return clients.size;
}

// Pushes the latest now-playing state (or null when nothing's playing) to
// every connected Now Playing overlay — called from
// lib/songQueueScheduler.js's poll tick, the same computation that already
// writes data/nowPlaying.json for the in-app Dashboard.
function pushNowPlaying(data) {
  lastNowPlaying = data;
  const payload = JSON.stringify({ type: "track", data });
  for (const res of nowPlayingClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

// Pushes a live overlay-appearance change (currently just alignment) to
// every connected Now Playing overlay — called from
// lib/persistence/songSettings.js's watch() whenever
// songRequestSettings.json changes, so a mod flipping the setting in the
// app doesn't have to reload the OBS browser source to see it take effect.
function pushNowPlayingSettings(align) {
  const payload = JSON.stringify({ type: "settings", data: { align: safeAlign(align) } });
  for (const res of nowPlayingClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

// Pushes a one-off Wordle event (guess/win/timeout/pause/reset) to every
// connected overlay — see lib/games/wordle.js for what triggers each.
function pushWordleEvent(data) {
  const payload = JSON.stringify(data);
  for (const res of wordleClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

// Pushes a full board snapshot (see wordle.js's getSnapshot()) to every
// connected overlay — used when the game's toggled off entirely via !sw, so
// open browser sources clear immediately instead of sitting on a stale
// board.
function pushWordleState(data) {
  const payload = JSON.stringify(data);
  for (const res of wordleClients) {
    res.write(`data: ${payload}\n\n`);
  }
}

let server = null;
function start() {
  if (server) return;
  if (!fs.existsSync(SFX_DIR)) fs.mkdirSync(SFX_DIR, { recursive: true });

  server = app.listen(SFX_SERVER_PORT, "127.0.0.1", () => {
    console.log(`[SFX] Browser source URL: http://localhost:${SFX_SERVER_PORT}/overlay`);
    console.log(`[SFX] Drop .mp3/.wav/.ogg files in: ${SFX_DIR}`);
    console.log(`[NOWPLAYING] Browser source URL: http://localhost:${SFX_SERVER_PORT}/nowplaying`);
    console.log(`[WORDLE] Browser source URL: http://localhost:${SFX_SERVER_PORT}/wordle`);
  });
}

module.exports = {
  start,
  playFile,
  pushNowPlaying,
  pushNowPlayingSettings,
  pushWordleEvent,
  pushWordleState,
  SFX_DIR,
};
