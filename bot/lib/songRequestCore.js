const spotify = require("./spotify");
const spotifyAuth = require("./spotifyAuth");
const queueStore = require("./persistence/songQueue");
const settingsStore = require("./persistence/songSettings");
const blocklistStore = require("./persistence/songBlocklist");

/* ------------------------------------------------------------------ */
/* Single entry point for turning a raw query into a pending request —  */
/* called by both the chat command (commands/songRequest.js) and the    */
/* channel-points redemption handler                                   */
/* (handlers/songRequestRedemption.js) so the eligibility/queueing      */
/* logic only lives in one place.                                      */
/*                                                                     */
/* Requests are only searched + recorded here, status "pending" —       */
/* they're NOT pushed into Spotify's real queue yet. Spotify's queue     */
/* API is add-only (no way to remove something once it's in there), so   */
/* lib/songQueueScheduler.js is what actually calls spotify.addToQueue,  */
/* a few seconds before the currently playing track ends. That delay is  */
/* what gives commands/removeRequest.js (!remove) a real window to work. */
/* ------------------------------------------------------------------ */

// Per-user cooldown gate — keyed by login, so one person redeeming doesn't
// make everyone else wait. Shared across chat and channel-points requests
// for the same person (keyed by requestedBy either way), so switching
// source can't be used to dodge your own cooldown.
const lastRequestAtByUser = new Map();

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isBlocked(query, login) {
  const bl = blocklistStore.blocklist;
  const q = query.toLowerCase();
  if (bl.users.some((u) => u.toLowerCase() === login.toLowerCase())) return "user";
  if (bl.songs.some((s) => s && q.includes(s.toLowerCase()))) return "song";
  if (bl.artists.some((a) => a && q.includes(a.toLowerCase()))) return "artist";
  return null;
}

// Returns remaining cooldown in whole seconds (0 if not on cooldown).
function cooldownRemainingSeconds(login) {
  const seconds = settingsStore.settings.cooldownSeconds || 0;
  if (seconds <= 0) return 0;

  const last = lastRequestAtByUser.get(login.toLowerCase()) || 0;
  const remainingMs = seconds * 1000 - (Date.now() - last);
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function countPendingForUser(login) {
  return queueStore.queue.filter(
    (r) => r.requestedBy.toLowerCase() === login.toLowerCase() && r.status === "pending"
  ).length;
}

// "Most generous applicable tier wins" — a viewer who qualifies for more
// than one tier (e.g. a Tier 2 sub who's also a Moderator) gets the highest
// of those limits, not a fixed precedence order. 0 on any qualifying tier
// means unlimited. roles: { isBroadcaster, isModerator, isVip, subTier }
// (subTier: null|1000|2000|3000).
function resolveUserLimit(roles = {}) {
  if (roles.isBroadcaster) return Infinity;

  const limits = settingsStore.settings.perTierLimits || {};
  const candidates = [limits.follower ?? 1]; // everyone qualifies for the base tier

  if (roles.isModerator) candidates.push(limits.moderator ?? 0);
  if (roles.isVip) candidates.push(limits.vip ?? 0);
  if (roles.subTier === 1000) candidates.push(limits.subT1 ?? 0);
  if (roles.subTier === 2000) candidates.push(limits.subT2 ?? 0);
  if (roles.subTier === 3000) candidates.push(limits.subT3 ?? 0);

  // A configured 0 means unlimited for that tier, which trumps everything.
  if (candidates.some((c) => c <= 0)) return Infinity;
  return Math.max(...candidates);
}

// redemption: optional { rewardId, redemptionId } for channel-points
// requests — carried on the queue entry so a later status update
// (fulfill on promotion, cancel/refund on !remove) can reference the right
// Twitch redemption. Absent entirely for chat requests, which have nothing
// to refund.
async function requestSong(query, requestedBy, source, roles = {}, redemption = null) {
  if (!spotifyAuth.isConfigured()) {
    return { ok: false, reason: "Spotify isn't connected yet." };
  }

  const trimmed = (query || "").trim();
  if (!trimmed) {
    return { ok: false, reason: "No song provided." };
  }

  const blockedType = isBlocked(trimmed, requestedBy);
  if (blockedType) {
    return { ok: false, reason: `That ${blockedType} is blocked.` };
  }

  const cooldownLeft = cooldownRemainingSeconds(requestedBy);
  if (cooldownLeft > 0) {
    return { ok: false, reason: `You're on cooldown — try again in ${cooldownLeft}s.` };
  }

  const limit = resolveUserLimit(roles);
  if (Number.isFinite(limit) && countPendingForUser(requestedBy) >= limit) {
    return { ok: false, reason: `You already have ${limit} pending request(s).` };
  }

  let track;
  try {
    track = await spotify.searchTrack(trimmed);
  } catch (e) {
    console.error("[SONGREQ] Search failed:", e.response?.data || e.message);
    return { ok: false, reason: "Spotify search failed." };
  }
  if (!track) {
    return { ok: false, reason: "Couldn't find that song on Spotify." };
  }

  const maxDurationMinutes = settingsStore.settings.maxDurationMinutes || 0;
  if (maxDurationMinutes > 0 && track.duration_ms > maxDurationMinutes * 60 * 1000) {
    return {
      ok: false,
      reason: `That song is ${formatDuration(track.duration_ms)} long — max is ${maxDurationMinutes} minute(s).`,
    };
  }

  lastRequestAtByUser.set(requestedBy.toLowerCase(), Date.now());

  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedBy,
    query: trimmed,
    trackUri: track.uri,
    title: track.name,
    artist: (track.artists || []).map((a) => a.name).join(", "),
    durationMs: track.duration_ms,
    status: "pending",
    requestedAt: Date.now(),
    source,
    rewardId: redemption?.rewardId || null,
    redemptionId: redemption?.redemptionId || null,
  };
  queueStore.queue.push(entry);
  queueStore.save();

  return { ok: true, track: entry };
}

module.exports = { requestSong, resolveUserLimit };
