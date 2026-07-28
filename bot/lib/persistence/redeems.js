const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const { DATA_DIR } = require("../paths");
const { ensureDataDir, atomicWriteFileSync } = require("./fsUtils");

/* ------------------------------------------------------------------ */
/* Local bot-side config for Channel Points redeems — keyed by Twitch's */
/* own reward id, not by name. This is deliberately separate from the   */
/* reward itself living on Twitch: attaching an action/constraint here  */
/* works for ANY reward id (including ones made through Twitch's own    */
/* dashboard), even though only rewards this app created can have their */
/* title/cost/prompt edited via the Helix API (see lib/twitchRewards.js).*/
/* ------------------------------------------------------------------ */

const REDEEMS_PATH = path.join(DATA_DIR, "redeems.json");

// Stable reference (never reassigned) — same reasoning as
// lib/persistence/customCommands.js. rewardId -> config.
const redeemConfigs = {};

function loadRedeems() {
  ensureDataDir();
  if (!fs.existsSync(REDEEMS_PATH)) {
    fs.writeFileSync(REDEEMS_PATH, JSON.stringify({}, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(REDEEMS_PATH, "utf8"));
    for (const key of Object.keys(redeemConfigs)) delete redeemConfigs[key];
    Object.assign(redeemConfigs, parsed);
    console.log(`Loaded redeem configs: ${Object.keys(redeemConfigs).length}`);
  } catch (e) {
    console.error("Failed to load redeems.json:", e);
  }
}

let _saveScheduled = false;
function saveRedeems() {
  if (_saveScheduled) return;
  _saveScheduled = true;

  setTimeout(() => {
    try {
      atomicWriteFileSync(REDEEMS_PATH, JSON.stringify(redeemConfigs, null, 2));
    } catch (e) {
      console.warn("Failed to save redeems.json:", e.message);
    } finally {
      _saveScheduled = false;
    }
  }, 150);
}

function watch() {
  chokidar.watch(REDEEMS_PATH, { ignoreInitial: true }).on("change", () => {
    console.log("[RAHHH] Reloading redeem configs");
    try {
      loadRedeems();
    } catch (e) {
      console.error("Redeem config reload failed:", e);
    }
  });
}

module.exports = { redeemConfigs, loadRedeems, saveRedeems, watch };
