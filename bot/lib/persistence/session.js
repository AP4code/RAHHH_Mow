const fs = require("fs");
const { SESSION_PATH } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

// `session` is a single stable object reference — every module that needs it
// requires this file once and reads/writes its fields directly. Never
// reassign `session` itself (e.g. `session = {...}`); that would only rebind
// this module's local variable and leave every other module holding a stale
// reference. Mutate fields in place instead (see reset()/load() below).
const session = {
  sessionShouted: [],
  lastChannelShoutoutAt: 0,
  lastShoutout: null,
  live: null,
  messageCounts: {},
  lastOfflineAt: 0, // real-world time the stream last went offline; used to gap-check resets
  // Real-world time the CURRENT stream session actually started — set once
  // when going online, deliberately left untouched by a "preserved" session
  // reconnect (a brief crash/restart within SESSION_GAP_RESET_MS) so uptime
  // math (e.g. games/coinToss.js's 40-minute-in gate) reflects when the
  // stream really started, not when it happened to reconnect.
  liveSince: 0,
};

const sessionShouted = new Set();
const messageCounts = new Map();

let _saveScheduled = false;
function save() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    ensureDataDir();

    // Snapshot the live Set/Map at write time, not call time — this is the
    // only point where the rebuild cost actually needs to be paid, since
    // only the state at flush matters (save() may be called many times per
    // debounce window, e.g. once per chat message).
    session.sessionShouted = Array.from(sessionShouted);

    const mcObj = {};
    for (const [k, v] of messageCounts) mcObj[k] = v;
    session.messageCounts = mcObj;

    try {
      atomicWriteFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
    } catch (e) {
      console.warn("Failed to write session.json:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

function load() {
  ensureDataDir();
  if (!fs.existsSync(SESSION_PATH)) return;

  const j = JSON.parse(fs.readFileSync(SESSION_PATH, "utf8"));
  Object.assign(session, j);

  sessionShouted.clear();
  (session.sessionShouted || []).forEach((u) => sessionShouted.add(u));

  messageCounts.clear();
  for (const [k, v] of Object.entries(session.messageCounts || {})) {
    if (v > 0) messageCounts.set(k, v);
  }

  console.log(
    `Loaded session: ${sessionShouted.size} already shouted; ${messageCounts.size} messageCounts`
  );
}

function reset(reason = "reset") {
  const lastOfflineAt = session.lastOfflineAt || 0; // offline bookkeeping survives a reset

  session.sessionShouted = [];
  session.lastChannelShoutoutAt = 0;
  session.lastShoutout = null;
  session.live = null;
  session.messageCounts = {};
  session.lastOfflineAt = lastOfflineAt;
  session.liveSince = 0;

  sessionShouted.clear();
  messageCounts.clear();

  save();
  console.log(`Session ${reason}.`);
}

module.exports = { session, sessionShouted, messageCounts, save, load, reset };
