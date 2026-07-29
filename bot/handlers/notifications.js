const sessionStore = require("../lib/persistence/session");
const shoutouts = require("../lib/shoutouts");
const { onChatMessage } = require("./chatMessage");
const { handleRedemption } = require("./redemptions");
const { handleSongRequestRedemption } = require("./songRequestRedemption");
const { handleCheckInRedemption } = require("./checkInRedemption");

// If the stream comes back online within this window of going offline, treat
// it as the same session (e.g. a crash/restart) and keep sessionShouted intact
// instead of letting already-shouted-out people get shouted out again a few
// minutes later. A longer gap means it's genuinely a new stream — start fresh.
const SESSION_GAP_RESET_MS = 2 * 60 * 60 * 1000; // 2 hours

async function handle(type, event) {
  switch (type) {
    case "channel.chat.message":
      return onChatMessage(event);

    case "channel.raid": {
      const from = event.from_broadcaster_user_login?.toLowerCase();
      if (from) {
        console.log(`[SHOUTOUT] Raid detected from ${from} (${event.viewers} viewers) — triggering shoutout`);
        await shoutouts.sendOfficialShoutout(from, "raid");
      }
      return;
    }

    case "stream.online": {
      const { session } = sessionStore;

      if (session.live === false) {
        const gap = session.lastOfflineAt ? Date.now() - session.lastOfflineAt : Infinity;

        if (gap >= SESSION_GAP_RESET_MS) {
          sessionStore.reset(`cleared (${Math.round(gap / 60000)}m since last stream — new session)`);
        } else {
          console.log(
            `[SESSION] Stream back online after ${Math.round(gap / 60000)}m — preserving session (no re-shoutouts)`
          );
        }
      }

      // Left alone on a preserved (not reset) session — see the field's own
      // comment in lib/persistence/session.js.
      if (!session.liveSince) session.liveSince = Date.now();

      session.live = true;
      sessionStore.save();
      return;
    }

    case "stream.offline": {
      const { session } = sessionStore;
      session.live = false;
      session.lastOfflineAt = Date.now();
      sessionStore.save();
      return;
    }

    case "channel.channel_points_custom_reward_redemption.add":
      // Independent handlers: the generic per-reward config system (Redeems
      // page) and the dedicated single-reward features (Song Requests,
      // Daily Check-In) never target the same reward id, so all three can
      // safely react to every event.
      return Promise.all([
        handleRedemption(event),
        handleSongRequestRedemption(event),
        handleCheckInRedemption(event),
      ]);
  }
}

module.exports = { handle };
