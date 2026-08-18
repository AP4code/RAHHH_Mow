const store = require("../lib/persistence/customCommands");
const { sendAs } = require("../lib/chat");
const { TARGET_CHANNEL_LOGIN } = require("../lib/env");
const { fillTemplate } = require("../lib/templateFill");
const { applyCounterAction } = require("../lib/counters");
const { getSubTier } = require("../lib/subscriptions");
const sfxServer = require("../lib/sfxServer");

/* ------------------------------------------------------------------ */
/* Streamer-authored commands (Command Maker UI) — data-driven, not     */
/* code, which is what lets these hot-reload with zero bot restart:    */
/* the UI just writes data/customCommands.json, chokidar picks it up   */
/* (see lib/persistence/customCommands.js), and the next chat message   */
/* sees the new command immediately.                                   */
/*                                                                     */
/* Kept last in commands/index.js on purpose: the UI blocks a custom    */
/* trigger from being saved if it collides with a built-in one, but if  */
/* customCommands.json is ever hand-edited around that, built-ins       */
/* still win rather than silently shadowing real bot functionality.     */
/* ------------------------------------------------------------------ */

// Permission is a set of independent gates, OR-matched — NOT a hierarchy.
// A moderator without an actual T3 sub does not satisfy a T3-only command
// just for being a mod; "moderator" only helps if it's one of the checked
// boxes. The one hardcoded exception is the broadcaster, who can always use
// every command regardless of what's checked (it's their channel).
// VIP deliberately isn't a gate here — Twitch VIP status has no sub-tier
// implication, which was the whole problem with the old ladder version.
//
// cmd.permissions is the current data shape: an array of zero or more of
// "everyone" | "subscriber" | "subscriberT2" | "subscriberT3" | "moderator".
// cmd.permission (singular, string) is the old ladder-era shape, still
// supported read-only for commands nobody's re-saved since this changed.
const LEGACY_PERMISSION_MAP = {
  everyone: ["everyone"],
  subscriber: ["subscriber"],
  subscriberT2: ["subscriberT2"],
  subscriberT3: ["subscriberT3"],
  vip: ["moderator"], // VIP no longer exists as a gate — fall back to the closer/stricter equivalent
  moderator: ["moderator"],
  broadcaster: [], // no gate matches a non-broadcaster; the standing broadcaster-always-passes rule does the rest
};

function getPermissionSet(cmd) {
  if (Array.isArray(cmd.permissions)) return cmd.permissions;
  if (cmd.permission) return LEGACY_PERMISSION_MAP[cmd.permission] || ["everyone"];
  return ["everyone"];
}

const globalCooldowns = new Map(); // commandId -> last-used timestamp
const perUserCooldowns = new Map(); // commandId -> Map(login -> last-used timestamp)

async function hasPermission(cmd, ctx) {
  if (ctx.isBroadcaster) return true;

  const required = getPermissionSet(cmd);
  if (required.includes("everyone")) return true;
  if (required.includes("moderator") && ctx.isMod) return true;

  if (!ctx.isSubscriber) return false;
  if (required.includes("subscriber")) return true;

  if (required.includes("subscriberT2") || required.includes("subscriberT3")) {
    const tier = await getSubTier(ctx.userId);
    if (tier === null) return false;
    if (required.includes("subscriberT2") && tier >= 2000) return true;
    if (required.includes("subscriberT3") && tier >= 3000) return true;
  }

  return false;
}

function isOnCooldown(cmd, login) {
  const mode = cmd.cooldown?.mode || "none";
  const seconds = cmd.cooldown?.seconds || 0;
  if (mode === "none" || seconds <= 0) return false;

  const now = Date.now();

  if (mode === "global") {
    return now - (globalCooldowns.get(cmd.id) || 0) < seconds * 1000;
  }

  if (mode === "peruser") {
    const userMap = perUserCooldowns.get(cmd.id);
    return now - (userMap?.get(login) || 0) < seconds * 1000;
  }

  return false;
}

function markUsed(cmd, login) {
  const mode = cmd.cooldown?.mode || "none";
  if (mode === "global") {
    globalCooldowns.set(cmd.id, Date.now());
  } else if (mode === "peruser") {
    if (!perUserCooldowns.has(cmd.id)) perUserCooldowns.set(cmd.id, new Map());
    perUserCooldowns.get(cmd.id).set(login, Date.now());
  }
}

function findMatch(msg) {
  return store.commandList.find(
    (cmd) => cmd.enabled !== false && (msg === cmd.trigger || msg.startsWith(`${cmd.trigger} `))
  );
}

// Whatever the chatter typed after the trigger, original case preserved —
// e.g. "!8ball will I win?" -> "will I win?". Sliced off ctx.message (not
// ctx.msg, which is lowercased) but at the same offset, since both are the
// same text trimmed, just differently cased.
function extractArgs(cmd, ctx) {
  return ctx.message.trim().slice(cmd.trigger.length).trim();
}

async function handleReply(cmd, ctx) {
  const replies = Array.isArray(cmd.replies) && cmd.replies.length ? cmd.replies : [""];
  const text = replies[Math.floor(Math.random() * replies.length)];
  const vars = { user: ctx.login, channel: TARGET_CHANNEL_LOGIN, args: extractArgs(cmd, ctx) };
  await sendAs(cmd.sendAs, fillTemplate(text, vars));
}

async function handleCounter(cmd, ctx) {
  if (!cmd.counter) return;

  const value = applyCounterAction(cmd.counter, cmd.action, cmd.step ?? 1);
  const vars = { user: ctx.login, channel: TARGET_CHANNEL_LOGIN, value, args: extractArgs(cmd, ctx) };
  await sendAs(cmd.sendAs, fillTemplate(cmd.template || "{value}", vars));
}

module.exports = {
  name: "customCommands",
  matches: (ctx) => Boolean(findMatch(ctx.msg)),
  handle: async (ctx) => {
    const cmd = findMatch(ctx.msg);
    if (!cmd) return;

    if (!(await hasPermission(cmd, ctx))) return;
    if (isOnCooldown(cmd, ctx.login)) return;

    markUsed(cmd, ctx.login);

    if (cmd.type === "counter") {
      await handleCounter(cmd, ctx);
    } else {
      await handleReply(cmd, ctx);
    }

    // Sfx is an add-on, not a command type — a Reply or Counter command can
    // also trigger a sound on top of its normal action.
    if (cmd.sfxFile) sfxServer.playFile(cmd.sfxFile, cmd.sfxVolume ?? 100);
  },
};
