const { TARGET_CHANNEL_LOGIN } = require("../lib/env");
const redeemsStore = require("../lib/persistence/redeems");
const snacksStore = require("../lib/persistence/snacks");
const { applyCounterAction } = require("../lib/counters");
const { fillTemplate } = require("../lib/templateFill");
const { sendBotMessage } = require("../lib/chat");
const { updateRedemptionStatus } = require("../lib/twitchRewards");
const { getSubTier } = require("../lib/subscriptions");
const sfxServer = require("../lib/sfxServer");

/* ------------------------------------------------------------------ */
/* Channel Points redemption handling.                                 */
/*                                                                     */
/* Twitch has no native "restrict to sub tier" or "per-user cooldown"   */
/* for custom rewards, so ineligible redemptions are allowed through    */
/* at the platform level and then explicitly CANCELED here, which is    */
/* what triggers Twitch's automatic point refund. This only works if    */
/* the reward has "Skip Reward Queue" off — see lib/twitchRewards.js.   */
/*                                                                     */
/* A reward with no entry in redeemConfigs is left completely alone —   */
/* no bot-side behavior is attached, so it just does whatever Twitch's  */
/* own settings (or the streamer, via the dashboard queue) dictate.     */
/* ------------------------------------------------------------------ */

const globalCooldowns = new Map(); // rewardId -> last-used timestamp
const perUserCooldowns = new Map(); // rewardId -> Map(userId -> last-used timestamp)

function isOnCooldown(cfg, rewardId, userId) {
  const mode = cfg.cooldown?.mode || "none";
  const seconds = cfg.cooldown?.seconds || 0;
  if (mode === "none" || seconds <= 0) return false;

  const now = Date.now();

  if (mode === "global") {
    return now - (globalCooldowns.get(rewardId) || 0) < seconds * 1000;
  }

  if (mode === "peruser") {
    const userMap = perUserCooldowns.get(rewardId);
    return now - (userMap?.get(userId) || 0) < seconds * 1000;
  }

  return false;
}

function markUsed(cfg, rewardId, userId) {
  const mode = cfg.cooldown?.mode || "none";
  if (mode === "global") {
    globalCooldowns.set(rewardId, Date.now());
  } else if (mode === "peruser") {
    if (!perUserCooldowns.has(rewardId)) perUserCooldowns.set(rewardId, new Map());
    perUserCooldowns.get(rewardId).set(userId, Date.now());
  }
}

// cfg.minSubTiers is the current shape: an array of 0/1000/2000/3000
// checkbox values, eligible if the actual tier clears ANY of them (which,
// since these are "and up" thresholds, is equivalent to clearing the
// lowest one checked). cfg.minSubTier (singular) is the old single-select
// dropdown's shape, still read for redeems nobody's re-saved since this
// became a checkbox group.
function getMinSubTiers(cfg) {
  if (Array.isArray(cfg.minSubTiers)) return cfg.minSubTiers;
  if (typeof cfg.minSubTier === "number") return [cfg.minSubTier];
  return [0];
}

async function meetsSubTier(cfg, userId) {
  const required = getMinSubTiers(cfg);
  if (required.length === 0 || required.includes(0)) return true;

  const tier = await getSubTier(userId);
  if (tier === null) return false;
  return required.some((r) => tier >= r);
}

async function runAction(cfg, event) {
  const vars = {
    user: event.user_login,
    channel: TARGET_CHANNEL_LOGIN,
    input: event.user_input || "",
  };

  if (cfg.action === "counter") {
    if (!cfg.counter) return;
    vars.value = applyCounterAction(cfg.counter, cfg.counterAction, cfg.step ?? 1);
    await sendBotMessage(fillTemplate(cfg.template || "{value}", vars));
    return;
  }

  if (cfg.action === "sfx") {
    if (cfg.sfxFile) sfxServer.playFile(cfg.sfxFile, cfg.sfxVolume ?? 100);
    return;
  }

  if (cfg.action === "snackCheckin") {
    const login = event.user_login;
    const amount = cfg.snackAmount ?? 1;
    const value = (snacksStore.snacks[login] ?? 0) + amount;
    snacksStore.snacks[login] = value;
    snacksStore.save();

    vars.value = value;
    await sendBotMessage(fillTemplate(cfg.snackTemplate || "{user} now has {value} Smoky snack(s)!", vars));
    return;
  }

  // default: "message"
  const replies = Array.isArray(cfg.replies) && cfg.replies.length ? cfg.replies : [""];
  const text = replies[Math.floor(Math.random() * replies.length)];
  await sendBotMessage(fillTemplate(text, vars));
}

async function handleRedemption(event) {
  const rewardId = event.reward?.id;
  const cfg = rewardId && redeemsStore.redeemConfigs[rewardId];
  if (!cfg || cfg.enabled === false) return;

  const userId = event.user_id;
  const eligible = (await meetsSubTier(cfg, userId)) && !isOnCooldown(cfg, rewardId, userId);

  if (!eligible) {
    console.log(`[REDEEM] Blocking ${event.user_login} on "${event.reward?.title}" — refunding`);
    try {
      await updateRedemptionStatus(rewardId, event.id, "CANCELED");
    } catch (e) {
      console.error("[REDEEM] Failed to cancel/refund — likely not queued (Skip Reward Queue is on):", e.response?.data || e.message);
    }
    return;
  }

  markUsed(cfg, rewardId, userId);

  try {
    await runAction(cfg, event);
    await updateRedemptionStatus(rewardId, event.id, "FULFILLED");
  } catch (e) {
    console.error("[REDEEM] Action or fulfillment failed:", e.response?.data || e.message);
  }
}

module.exports = { handleRedemption };
