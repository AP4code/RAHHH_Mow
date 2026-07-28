const fs = require("fs");
const chokidar = require("chokidar");
const { SONG_BLOCKLIST_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

const DEFAULTS = { users: [], songs: [], artists: [] };

// Stable object reference (never reassigned) — same reasoning as
// lib/persistence/redeems.js. Songs/artists are matched by substring, not
// exact membership, so these stay plain arrays rather than Sets.
const blocklist = { users: [], songs: [], artists: [] };

function loadBlocklist() {
  ensureDataDir();
  if (!fs.existsSync(SONG_BLOCKLIST_PATH)) {
    fs.writeFileSync(SONG_BLOCKLIST_PATH, JSON.stringify(DEFAULTS, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(SONG_BLOCKLIST_PATH, "utf8"));
    blocklist.users = Array.isArray(parsed.users) ? parsed.users : [];
    blocklist.songs = Array.isArray(parsed.songs) ? parsed.songs : [];
    blocklist.artists = Array.isArray(parsed.artists) ? parsed.artists : [];
    console.log(
      `Loaded song blocklist: ${blocklist.users.length} user(s), ${blocklist.songs.length} song(s), ${blocklist.artists.length} artist(s)`
    );
  } catch (e) {
    console.error("Failed to load songBlocklist.json:", e);
  }
}

let _saveScheduled = false;
function save() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(SONG_BLOCKLIST_PATH, JSON.stringify(blocklist, null, 2));
    } catch (e) {
      console.warn("Failed to save songBlocklist.json:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

function watch() {
  chokidar.watch(SONG_BLOCKLIST_PATH, { ignoreInitial: true }).on("change", () => {
    console.log("[RAHHH] Reloading song blocklist");
    try {
      loadBlocklist();
    } catch (e) {
      console.error("Song blocklist reload failed:", e);
    }
  });
}

module.exports = { blocklist, loadBlocklist, save, watch };
