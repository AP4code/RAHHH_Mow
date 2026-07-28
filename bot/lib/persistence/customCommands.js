const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const { DATA_DIR } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

const COMMANDS_PATH = path.join(DATA_DIR, "customCommands.json");
const COUNTERS_PATH = path.join(DATA_DIR, "counters.json");

// Stable references (never reassigned) — same reasoning as allowlist/viplist
// in lists.js: every module that requires this file needs to keep seeing
// live updates after a chokidar-triggered reload, which only works if the
// container itself is never rebound.
const commandList = [];
const counters = {};

// Seeded on first run only (i.e. the file doesn't exist yet) — these were
// previously hardcoded quick-reply commands; now they're just ordinary
// entries a streamer can freely edit or delete from the Command Maker UI.
const DEFAULT_COMMANDS = [
  {
    id: "hi",
    trigger: "!hi",
    type: "reply",
    replies: ["what? missmeowBONK "],
    permission: "everyone",
    cooldown: { mode: "none", seconds: 0 },
    enabled: true,
  },
  {
    id: "grules",
    trigger: "!grules",
    type: "reply",
    replies: [
      "GIVEAWAYS! rules -> To enter the giveaway - do the Gamba redeem || Subscribers can do the !join command to join the giveaway!",
    ],
    permission: "everyone",
    cooldown: { mode: "none", seconds: 0 },
    enabled: true,
  },
];

function loadCommands() {
  ensureDataDir();
  if (!fs.existsSync(COMMANDS_PATH)) {
    fs.writeFileSync(COMMANDS_PATH, JSON.stringify({ commands: DEFAULT_COMMANDS }, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(COMMANDS_PATH, "utf8"));
    commandList.length = 0;
    commandList.push(...(parsed.commands || []));
    console.log(`Loaded custom commands: ${commandList.length}`);
  } catch (e) {
    console.error("Failed to load customCommands.json:", e);
  }
}

let _saveCommandsScheduled = false;
function saveCommands() {
  // The UI is the normal writer here (via the generic save_list Tauri
  // command), but this exists so bot-side code can persist a change too
  // (e.g. auto-disabling a command) without duplicating the write logic.
  if (_saveCommandsScheduled) return;
  _saveCommandsScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(COMMANDS_PATH, JSON.stringify({ commands: commandList }, null, 2));
    } catch (e) {
      console.warn("Failed to save customCommands.json:", e.message);
    } finally {
      _saveCommandsScheduled = false;
    }
  }, 150);
}

function loadCounters() {
  ensureDataDir();
  if (!fs.existsSync(COUNTERS_PATH)) {
    fs.writeFileSync(COUNTERS_PATH, JSON.stringify({}, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(COUNTERS_PATH, "utf8"));
    for (const key of Object.keys(counters)) delete counters[key];
    Object.assign(counters, parsed);
    console.log(`Loaded counters: ${Object.keys(counters).length}`);
  } catch (e) {
    console.error("Failed to load counters.json:", e);
  }
}

let _saveCountersScheduled = false;
function saveCounters() {
  if (_saveCountersScheduled) return;
  _saveCountersScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(COUNTERS_PATH, JSON.stringify(counters, null, 2));
    } catch (e) {
      console.warn("Failed to save counters.json:", e.message);
    } finally {
      _saveCountersScheduled = false;
    }
  }, 150);
}

function watch() {
  chokidar.watch([COMMANDS_PATH, COUNTERS_PATH], { ignoreInitial: true }).on("change", (file) => {
    console.log(`[RAHHH] Reloading: ${path.basename(file)}`);
    try {
      if (file.includes("customCommands")) loadCommands();
      if (file.includes("counters")) loadCounters();
    } catch (e) {
      console.error("Custom command/counter reload failed:", e);
    }
  });
}

module.exports = { commandList, counters, loadCommands, saveCommands, loadCounters, saveCounters, watch };
