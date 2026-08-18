const fs = require("fs");
const chokidar = require("chokidar");
const { CHECKIN_SETTINGS_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

/* ------------------------------------------------------------------ */
/* Daily Check-In — a single dedicated channel-point reward drives       */
/* check-ins directly (see handlers/checkInRedemption.js), same "one     */
/* dedicated redeem" shape as Song Requests, independent of the generic  */
/* per-reward Redeems page system.                                     */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  enabled: false,
  redeemId: "",
  pointsPerCheckIn: 1,
  // Sent as two separate chat messages, back to back — matches the exact
  // two-line format the previous check-in bot used, so the switch to
  // sending from rahhh itself doesn't change what viewers actually see.
  message: "{user} has checked in! Thank you for being here! <3",
  message2: "{user} now has {value} delicious Smoky snack(s)!",
  // "streamer" preserves original behavior for anyone who saved settings
  // before this existed — check-in always sent as the broadcaster, never
  // the bot, so that stays the default rather than switching to "bot" like
  // commands/redeems (which never had a prior fixed sender to preserve).
  sendAs: "streamer",
};

// Stable object reference (never reassigned) — same reasoning as
// lib/persistence/redeems.js.
const settings = { ...DEFAULTS };

function loadSettings() {
  ensureDataDir();
  if (!fs.existsSync(CHECKIN_SETTINGS_PATH)) {
    fs.writeFileSync(CHECKIN_SETTINGS_PATH, JSON.stringify(DEFAULTS, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CHECKIN_SETTINGS_PATH, "utf8"));
    Object.assign(settings, DEFAULTS, parsed);
    console.log("Loaded Daily Check-In settings");
  } catch (e) {
    console.error("Failed to load checkInSettings.json:", e);
  }
}

let _saveScheduled = false;
function save() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(CHECKIN_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch (e) {
      console.warn("Failed to save checkInSettings.json:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

function watch() {
  chokidar.watch(CHECKIN_SETTINGS_PATH, { ignoreInitial: true }).on("change", () => {
    console.log("[RAHHH] Reloading Daily Check-In settings");
    try {
      loadSettings();
    } catch (e) {
      console.error("Daily Check-In settings reload failed:", e);
    }
  });
}

module.exports = { settings, loadSettings, save, watch };
