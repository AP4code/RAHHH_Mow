const fs = require("fs");
const chokidar = require("chokidar");
const { SONG_SETTINGS_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

const DEFAULTS = {
  chatEnabled: false,
  chatCommand: "!sr",
  // Who can use the chat command — "follower" means everyone (the base tier,
  // same meaning as in perTierLimits below). Sub tier entries are "and up"
  // (subT2 also passes for a Tier 3 sub), matching how permission gates work
  // everywhere else in this app (see commands/customCommands.js). The
  // broadcaster can always use it regardless of what's checked here — not a
  // checkbox, a hardcoded exception, same as every other command.
  chatPermissions: ["follower"],
  channelPointsEnabled: false,
  redeemId: "",
  cooldownSeconds: 0,
  // 0 = no limit — rejects a request whose Spotify track duration exceeds
  // this many minutes (see lib/songRequestCore.js).
  maxDurationMinutes: 0,
  // Max pending requests per role — most-generous-applicable-tier wins when a
  // viewer qualifies for more than one (see lib/songRequestCore.js). 0 means
  // unlimited for that tier.
  perTierLimits: {
    follower: 1,
    vip: 2,
    moderator: 0,
    subT1: 2,
    subT2: 3,
    subT3: 5,
  },
  // How many seconds before the currently playing track ends the next
  // pending request actually gets pushed into Spotify's real queue — the
  // window during which !remove still works (see lib/songQueueScheduler.js).
  promoteBeforeEndSeconds: 5,
  addToPlaylistId: "",
};

// Stable object reference (never reassigned) — same reasoning as
// lib/persistence/redeems.js.
const settings = { ...DEFAULTS };

function loadSettings() {
  ensureDataDir();
  if (!fs.existsSync(SONG_SETTINGS_PATH)) {
    fs.writeFileSync(SONG_SETTINGS_PATH, JSON.stringify(DEFAULTS, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SONG_SETTINGS_PATH, "utf8"));
    Object.assign(settings, DEFAULTS, parsed);
    console.log("Loaded song request settings");
  } catch (e) {
    console.error("Failed to load songRequestSettings.json:", e);
  }
}

let _saveScheduled = false;
function save() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(SONG_SETTINGS_PATH, JSON.stringify(settings, null, 2));
    } catch (e) {
      console.warn("Failed to save songRequestSettings.json:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

function watch() {
  chokidar.watch(SONG_SETTINGS_PATH, { ignoreInitial: true }).on("change", () => {
    console.log("[RAHHH] Reloading song request settings");
    try {
      loadSettings();
    } catch (e) {
      console.error("Song request settings reload failed:", e);
    }
  });
}

module.exports = { settings, loadSettings, save, watch };
