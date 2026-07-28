const state = require("./state");
const { helix, streamerToken } = require("./auth");

/* ------------------------------------------------------------------ */
/* Channel Points Custom Rewards — always the streamer's own token,     */
/* since managing rewards requires channel:manage:redemptions and      */
/* checking a redeemer's sub tier requires channel:read:subscriptions. */
/* ------------------------------------------------------------------ */

const REWARDS_URL = "https://api.twitch.tv/helix/channel_points/custom_rewards";
const REDEMPTIONS_URL = "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions";

/**
 * Lists every reward on the channel, each annotated with `manageable` —
 * whether this app's client created it and can therefore edit/delete it via
 * the API. Twitch only lets an app manage rewards it created itself;
 * dashboard-made (or another-app-made) rewards come back with
 * manageable:false, which the UI uses to gray out title/cost/prompt editing
 * while still allowing our own bot-side action/constraint config to attach.
 */
async function listRewards() {
  const [{ data: all }, { data: manageable }] = await Promise.all([
    helix(streamerToken, {
      method: "get",
      url: REWARDS_URL,
      params: { broadcaster_id: state.broadcasterId },
    }),
    helix(streamerToken, {
      method: "get",
      url: REWARDS_URL,
      params: { broadcaster_id: state.broadcasterId, only_manageable_rewards: true },
    }),
  ]);

  const manageableIds = new Set((manageable.data || []).map((r) => r.id));
  return (all.data || []).map((r) => ({ ...r, manageable: manageableIds.has(r.id) }));
}

async function createReward(config) {
  const { data } = await helix(streamerToken, {
    method: "post",
    url: REWARDS_URL,
    headers: { "Content-Type": "application/json" },
    params: { broadcaster_id: state.broadcasterId },
    data: config,
  });
  return data.data?.[0] || null;
}

async function updateReward(rewardId, config) {
  const { data } = await helix(streamerToken, {
    method: "patch",
    url: REWARDS_URL,
    headers: { "Content-Type": "application/json" },
    params: { broadcaster_id: state.broadcasterId, id: rewardId },
    data: config,
  });
  return data.data?.[0] || null;
}

async function deleteReward(rewardId) {
  await helix(streamerToken, {
    method: "delete",
    url: REWARDS_URL,
    params: { broadcaster_id: state.broadcasterId, id: rewardId },
  });
}

/**
 * status: "FULFILLED" | "CANCELED" — CANCELED is what triggers Twitch's
 * automatic point refund to the redeemer.
 */
async function updateRedemptionStatus(rewardId, redemptionId, status) {
  const { data } = await helix(streamerToken, {
    method: "patch",
    url: REDEMPTIONS_URL,
    headers: { "Content-Type": "application/json" },
    params: { broadcaster_id: state.broadcasterId, reward_id: rewardId, id: redemptionId },
    data: { status },
  });
  return data.data?.[0] || null;
}

module.exports = { listRewards, createReward, updateReward, deleteReward, updateRedemptionStatus };
