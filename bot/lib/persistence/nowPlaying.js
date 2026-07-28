const fs = require("fs");
const { NOW_PLAYING_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

/* ------------------------------------------------------------------ */
/* Write-only cache of Spotify's currently-playing track, refreshed by  */
/* a poll interval in bot.js. No chokidar watch — nothing in-process    */
/* needs to react to this file changing, it exists purely so the Tauri  */
/* frontend can read it on demand via load_list("nowPlaying").          */
/* ------------------------------------------------------------------ */

function ensureFile() {
  ensureDataDir();
  if (!fs.existsSync(NOW_PLAYING_PATH)) {
    fs.writeFileSync(NOW_PLAYING_PATH, JSON.stringify(null));
  }
}

function save(data) {
  ensureDataDir();
  try {
    atomicWriteFileSync(NOW_PLAYING_PATH, JSON.stringify(data ?? null, null, 2));
  } catch (e) {
    console.warn("Failed to save nowPlaying.json:", e.message);
  }
}

module.exports = { ensureFile, save };
