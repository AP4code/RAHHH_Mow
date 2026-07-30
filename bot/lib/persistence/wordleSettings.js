const fs = require("fs");
const chokidar = require("chokidar");
const { WORDLE_SETTINGS_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

const DEFAULTS = {
  // Chat trigger that toggles the whole game on/off (see commands/startWordle.js).
  chatCommand: "!sw",
  roundDurationSeconds: 105,
  // Gap after a win/timeout before the next round auto-starts.
  autoRestartDelaySeconds: 10,
};

// Stable object reference (never reassigned) — same reasoning as
// lib/persistence/redeems.js.
const settings = { ...DEFAULTS };

function loadSettings() {
  ensureDataDir();
  if (!fs.existsSync(WORDLE_SETTINGS_PATH)) {
    fs.writeFileSync(WORDLE_SETTINGS_PATH, JSON.stringify(DEFAULTS, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(WORDLE_SETTINGS_PATH, "utf8"));
    Object.assign(settings, DEFAULTS, parsed);
    console.log("Loaded Wordle settings");
  } catch (e) {
    console.error("Failed to load wordleSettings.json:", e);
  }
}

let _saveScheduled = false;
function save() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(WORDLE_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch (e) {
      console.warn("Failed to save wordleSettings.json:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

function watch() {
  chokidar.watch(WORDLE_SETTINGS_PATH, { ignoreInitial: true }).on("change", () => {
    console.log("[RAHHH] Reloading Wordle settings");
    try {
      loadSettings();
    } catch (e) {
      console.error("Wordle settings reload failed:", e);
    }
  });
}

module.exports = { settings, loadSettings, save, watch };
