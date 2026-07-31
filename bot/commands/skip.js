const { sendBotMessage } = require("../lib/chat");
const spotify = require("../lib/spotify");
const spotifyAuth = require("../lib/spotifyAuth");
const queueStore = require("../lib/persistence/songQueue");
const { updateRedemptionStatus } = require("../lib/twitchRewards");
const overrides = require("../lib/messageOverrides");

const MESSAGES = {
  skippedToRequest: {
    default: '⏭️ Skipped — now playing "{title}" by {artist}, requested by @{requester}!',
    description: "Sent when !skip promotes the next song request and skips to it.",
    placeholders: ["title", "artist", "requester"],
  },
  skippedToQueue: {
    default: "⏭️ Skipped to whatever's next in the Spotify queue.",
    description:
      "Sent when !skip is used but there's no pending song request to promote. {title}/{artist} are best-effort — left blank if Spotify hasn't updated its playback state yet by the time this is sent.",
    placeholders: ["user", "title", "artist"],
  },
  failed: {
    default: "⚠️ Couldn't skip — {reason}",
    description: "Sent when !skip fails before anything changed (no request was promoted).",
    placeholders: ["reason"],
  },
  queuedButNotSkipped: {
    default:
      '⚠️ Added "{title}" by {artist} to the Spotify queue, but couldn\'t skip to it — {reason} It\'ll play after the current song instead.',
    description:
      "Sent when !skip promotes a request into Spotify's real queue but the skip-to-it call then fails. The request is already committed (no longer removable) even though the skip itself didn't happen.",
    placeholders: ["title", "artist", "reason"],
  },
};

overrides.registerDefaults("skip", MESSAGES);

// Mirrors songQueueScheduler.js's promotion step, but triggered on-demand
// instead of on the 3s poll tick. Flips status to "sent" synchronously
// before the await so a concurrent scheduler tick can't also grab the same
// entry; rolled back to "pending" if the Spotify call actually fails.
async function promoteNextPending() {
  const next = queueStore.queue.find((r) => r.status === "pending");
  if (!next) return null;

  next.status = "sent";
  try {
    await spotify.addToQueue(next.trackUri);
  } catch (e) {
    next.status = "pending";
    throw e;
  }
  queueStore.save();
  console.log(`[SONGREQ] Promoted "${next.title}" (requested by ${next.requestedBy}) into Spotify's queue via !skip`);

  if (next.rewardId && next.redemptionId) {
    try {
      await updateRedemptionStatus(next.rewardId, next.redemptionId, "FULFILLED");
    } catch (e) {
      console.error("[SONGREQ] Failed to mark redemption fulfilled:", e.response?.data || e.message);
    }
  }

  return next;
}

module.exports = {
  name: "skip",
  matches: (ctx) => ctx.isModOrBroadcaster && ctx.msg === "!skip",
  handle: async (ctx) => {
    if (!spotifyAuth.isConfigured()) {
      await sendBotMessage(
        overrides.getMessage("skip", "failed", MESSAGES.failed.default, {
          reason: "Spotify isn't connected.",
        }),
        ctx.messageId
      );
      return;
    }

    let promoted;
    try {
      promoted = await promoteNextPending();
    } catch (e) {
      console.error("[SONGREQ] !skip promotion failed:", e.response?.data || e.message);
      await sendBotMessage(
        overrides.getMessage("skip", "failed", MESSAGES.failed.default, {
          reason: "failed to queue the next request.",
        }),
        ctx.messageId
      );
      return;
    }

    try {
      await spotify.skip();
    } catch (e) {
      console.error("[SONGREQ] !skip failed:", e.response?.data || e.message);

      // If a request was already promoted into Spotify's real queue, that's
      // committed and no longer removable regardless of whether the skip
      // itself worked — say so honestly instead of implying nothing happened.
      if (promoted) {
        await sendBotMessage(
          overrides.getMessage("skip", "queuedButNotSkipped", MESSAGES.queuedButNotSkipped.default, {
            title: promoted.title,
            artist: promoted.artist,
            reason: "Spotify wouldn't skip.",
          }),
          ctx.messageId
        );
      } else {
        await sendBotMessage(
          overrides.getMessage("skip", "failed", MESSAGES.failed.default, {
            reason: "Spotify wouldn't skip.",
          }),
          ctx.messageId
        );
      }
      return;
    }

    if (promoted) {
      await sendBotMessage(
        overrides.getMessage("skip", "skippedToRequest", MESSAGES.skippedToRequest.default, {
          title: promoted.title,
          artist: promoted.artist,
          requester: promoted.requestedBy,
        }),
        ctx.messageId
      );
    } else {
      // Best-effort — Spotify's playback state can lag a beat behind the
      // skip actually landing, so title/artist may come back blank. That's
      // fine: fillTemplate substitutes an empty string for a known var
      // rather than leaving the raw {placeholder} in the sent message.
      let nowPlaying = null;
      try {
        const playback = await spotify.getPlaybackState();
        if (playback?.item) {
          nowPlaying = {
            title: playback.item.name,
            artist: (playback.item.artists || []).map((a) => a.name).join(", "),
          };
        }
      } catch (e) {
        console.error("[SONGREQ] Failed to fetch now-playing after !skip:", e.response?.data || e.message);
      }

      await sendBotMessage(
        overrides.getMessage("skip", "skippedToQueue", MESSAGES.skippedToQueue.default, {
          user: ctx.login,
          title: nowPlaying?.title || "",
          artist: nowPlaying?.artist || "",
        }),
        ctx.messageId
      );
    }
  },
};
