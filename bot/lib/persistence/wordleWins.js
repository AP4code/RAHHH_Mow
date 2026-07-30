const fs = require("fs");
const chokidar = require("chokidar");
const { WORDLE_WINS_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

/* ------------------------------------------------------------------ */
/* Wordle win leaderboard — login -> total wins. Watched (unlike         */
/* snacks.js) because the Tauri "import_wordle_wins" command can write   */
/* this file directly from Settings while the bot's already running,     */
/* merging in whatever the old standalone Wordle exe had recorded.       */
/* ------------------------------------------------------------------ */

// Stable object reference (never reassigned) — same reasoning as
// lib/persistence/redeems.js.
const wins = {};

function loadWins() {
  ensureDataDir();
  if (!fs.existsSync(WORDLE_WINS_PATH)) {
    fs.writeFileSync(WORDLE_WINS_PATH, JSON.stringify({}, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(WORDLE_WINS_PATH, "utf8"));
    for (const key of Object.keys(wins)) delete wins[key];
    Object.assign(wins, parsed);
    console.log(`Loaded Wordle wins: ${Object.keys(wins).length} user(s)`);
  } catch (e) {
    console.error("Failed to load wordleWins.json:", e);
  }
}

let _saveScheduled = false;
function save() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(WORDLE_WINS_PATH, JSON.stringify(wins, null, 2));
    } catch (e) {
      console.warn("Failed to save wordleWins.json:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

function watch() {
  chokidar.watch(WORDLE_WINS_PATH, { ignoreInitial: true }).on("change", () => {
    console.log("[RAHHH] Reloading Wordle wins");
    try {
      loadWins();
    } catch (e) {
      console.error("Wordle wins reload failed:", e);
    }
  });
}

module.exports = { wins, loadWins, save, watch };
