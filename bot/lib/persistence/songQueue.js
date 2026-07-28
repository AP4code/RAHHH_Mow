const fs = require("fs");
const chokidar = require("chokidar");
const { SONG_QUEUE_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

/* ------------------------------------------------------------------ */
/* Local record of song requests — separate from Spotify's own device   */
/* queue, which has no API for listing/removing individual items. This  */
/* is what the Song Requests tab actually displays and edits.           */
/* ------------------------------------------------------------------ */

// Stable array reference (never reassigned) — same reasoning as
// lib/persistence/redeems.js.
const queue = [];

function loadQueue() {
  ensureDataDir();
  if (!fs.existsSync(SONG_QUEUE_PATH)) {
    fs.writeFileSync(SONG_QUEUE_PATH, JSON.stringify([], null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SONG_QUEUE_PATH, "utf8"));
    queue.length = 0;
    if (Array.isArray(parsed)) queue.push(...parsed);
    console.log(`Loaded song queue: ${queue.length} request(s)`);
  } catch (e) {
    console.error("Failed to load songQueue.json:", e);
  }
}

// Called at bot startup instead of loadQueue() — requests are scoped to the
// current bot session, not persisted indefinitely across restarts. Written
// immediately (not debounced like save()) so the file reflects empty before
// anything else — chokidar's watch, the Tauri UI — might read it.
function resetQueue() {
  ensureDataDir();
  queue.length = 0;
  try {
    atomicWriteFileSync(SONG_QUEUE_PATH, JSON.stringify(queue, null, 2));
    console.log("Cleared song queue for new bot session");
  } catch (e) {
    console.warn("Failed to reset songQueue.json:", e.message);
  }
}

let _saveScheduled = false;
function save() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(SONG_QUEUE_PATH, JSON.stringify(queue, null, 2));
    } catch (e) {
      console.warn("Failed to save songQueue.json:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

function watch() {
  chokidar.watch(SONG_QUEUE_PATH, { ignoreInitial: true }).on("change", () => {
    console.log("[RAHHH] Reloading song queue");
    try {
      loadQueue();
    } catch (e) {
      console.error("Song queue reload failed:", e);
    }
  });
}

module.exports = { queue, loadQueue, resetQueue, save, watch };
