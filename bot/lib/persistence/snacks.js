const fs = require("fs");
const { SNACKS_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

// Stable object reference (never reassigned) — loaded once at boot, so a
// plain Object.assign onto it is enough (no chokidar watch on this file, so
// there's no "remove stale keys on reload" concern like allowlist/viplist).
const snacks = {};

function load() {
  ensureDataDir();
  if (!fs.existsSync(SNACKS_PATH)) {
    fs.writeFileSync(SNACKS_PATH, JSON.stringify({}, null, 2));
  }

  try {
    Object.assign(snacks, JSON.parse(fs.readFileSync(SNACKS_PATH, "utf8")));
    console.log(`Loaded snacks: ${Object.keys(snacks).length} users`);
  } catch (e) {
    console.error("Failed to load snacks.json:", e);
  }
}

let _saveScheduled = false;
function save() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(SNACKS_PATH, JSON.stringify(snacks, null, 2));
    } catch (e) {
      console.warn("Failed to save snacks:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

module.exports = { snacks, load, save };
