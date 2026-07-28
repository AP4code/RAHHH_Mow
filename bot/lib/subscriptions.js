const state = require("./state");
const { helix, streamerToken } = require("./auth");

/* ------------------------------------------------------------------ */
/* Subscriber-tier lookups — used to gate redeems by "Tier 2+" etc.     */
/* Twitch has no such restriction natively, so we look it up ourselves  */
/* on redemption and refund the ineligible ones. Cached briefly since   */
/* the same viewer can redeem multiple gated rewards in quick           */
/* succession and tier rarely changes mid-stream.                       */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // userId -> { tier: 1000|2000|3000|null, expiresAt }

/**
 * Returns the user's sub tier as a number (1000/2000/3000) or null if
 * they're not subscribed. Returns null (without caching) on a lookup
 * failure too — safer to retry next time than to cache a false negative
 * from a transient error and lock someone out of a gated redeem.
 */
async function getSubTier(userId) {
  const cached = cache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  let tier = null;
  try {
    const { data } = await helix(streamerToken, {
      method: "get",
      url: "https://api.twitch.tv/helix/subscriptions",
      params: { broadcaster_id: state.broadcasterId, user_id: userId },
    });
    const sub = data.data?.[0];
    tier = sub ? parseInt(sub.tier, 10) : null;
  } catch (e) {
    console.error("[SUBS] Tier lookup failed:", e.response?.data || e.message);
    return null;
  }

  cache.set(userId, { tier, expiresAt: Date.now() + CACHE_TTL_MS });
  return tier;
}

module.exports = { getSubTier };
