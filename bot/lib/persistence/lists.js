const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const { ALLOWLIST_PATH, VIPLIST_PATH } = require("../paths");
const { ensureDataDir } = require("./fsUtils");

// Stable Set references (never reassigned) so every module that requires
// this file keeps seeing live updates after a chokidar-triggered reload.
const allowlist = new Set();
const viplist = new Set();

function loadAllowlist() {
  ensureDataDir();
  if (!fs.existsSync(ALLOWLIST_PATH)) {
    fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify({ users: [] }, null, 2));
  }

  const j = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
  allowlist.clear();
  for (const u of j.users || []) allowlist.add(u.toLowerCase());
  console.log(`Loaded allowlist: ${allowlist.size} users`);
}

function loadViplist() {
  ensureDataDir();
  if (!fs.existsSync(VIPLIST_PATH)) {
    fs.writeFileSync(VIPLIST_PATH, JSON.stringify({ users: [] }, null, 2));
  }

  const j = JSON.parse(fs.readFileSync(VIPLIST_PATH, "utf8"));
  viplist.clear();
  for (const u of j.users || []) viplist.add(u.toLowerCase());
  console.log(`Loaded VIP list: ${viplist.size} users`);
}

function watch() {
  chokidar.watch([ALLOWLIST_PATH, VIPLIST_PATH], { ignoreInitial: true }).on("change", (file) => {
    console.log(`[RAHHH] Reloading list: ${path.basename(file)}`);

    try {
      if (file.includes("allowlist")) loadAllowlist();
      if (file.includes("VIPList")) loadViplist();
    } catch (e) {
      console.error("List reload failed:", e);
    }
  });
}

module.exports = { allowlist, viplist, loadAllowlist, loadViplist, watch };
