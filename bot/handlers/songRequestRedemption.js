const settingsStore = require("../lib/persistence/songSettings");
const { requestSong } = require("../lib/songRequestCore");
const { updateRedemptionStatus } = require("../lib/twitchRewards");
const { sendBotMessage } = require("../lib/chat");
const { getSubTier } = require("../lib/subscriptions");
const state = require("../lib/state");

/* ------------------------------------------------------------------ */
/* Channel-point song requests — deliberately independent from          */
/* lib/persistence/redeems.js and the Redeems page/handlers/redemptions */
/* .js. There's only ever one reward that can trigger a song request,   */
/* chosen on the dedicated Song Requests tab (songSettings.redeemId),   */
/* so this doesn't need the generic per-reward action-config system     */
/* the Redeems page uses for everything else.                          */
/* ------------------------------------------------------------------ */

async function handleSongRequestRedemption(event) {
  const settings = settingsStore.settings;
  if (!settings.channelPointsEnabled || !settings.redeemId) return;

  const rewardId = event.reward?.id;
  if (rewardId !== settings.redeemId) return;

  // VIP/Moderator status isn't available on a redemption event (no chat
  // badges here, and looking them up separately would need yet more Twitch
  // scopes) — channel-point redeemers get Follower/Sub-tier limits only.
  const roles = {
    isBroadcaster: event.user_id === state.broadcasterId,
    isModerator: false,
    isVip: false,
    subTier: await getSubTier(event.user_id),
  };

  const query = event.user_input || "";
  const result = await requestSong(query, event.user_login, "channelPoints", roles, {
    rewardId,
    redemptionId: event.id,
  });

  // Only cancel (refund) here on immediate rejection — success does NOT
  // mark "FULFILLED" yet. The redemption stays queued/unfulfilled on
  // Twitch's side until lib/songQueueScheduler.js actually promotes this
  // request into Spotify's real queue, which is what "fulfilled" should
  // actually mean. That gap is also what lets commands/removeRequest.js
  // (!remove) still trigger a real refund for a request that never played.
  if (!result.ok) {
    try {
      await updateRedemptionStatus(rewardId, event.id, "CANCELED");
    } catch (e) {
      console.error(
        "[SONGREQ] Failed to cancel/refund redemption — likely not queued (Skip Reward Queue is on):",
        e.response?.data || e.message
      );
    }

    console.log(`[SONGREQ] Redemption from ${event.user_login} rejected — ${result.reason}`);
    await sendBotMessage(`@${event.user_login} ${result.reason}`);
  }
}

module.exports = { handleSongRequestRedemption };
