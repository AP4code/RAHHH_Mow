const { sendBotMessage } = require("../lib/chat");
const spotify = require("../lib/spotify");
const spotifyAuth = require("../lib/spotifyAuth");
const { findRequesterForTrack } = require("../lib/upcomingSongs");
const overrides = require("../lib/messageOverrides");

/* ------------------------------------------------------------------ */
/* !song — shows what's currently playing. Attribution comes from        */
/* matching the live track's URI against this app's own queue history:   */
/* an entry stays there with status "sent" after                        */
/* lib/songQueueScheduler.js promotes it, so a URI match means this      */
/* track was requested through the bot rather than played manually.      */
/* ------------------------------------------------------------------ */

const MESSAGES = {
  notConfigured: {
    default: "Spotify isn't connected yet.",
    description: "Sent when !song is used but Spotify hasn't been connected.",
    placeholders: [],
  },
  nothingPlaying: {
    default: "Nothing's playing right now.",
    description: "Sent when !song is used but Spotify has no active playback.",
    placeholders: [],
  },
  current: {
    default: "{title} - {artist}",
    description: "Sent by !song for a track that wasn't requested through this bot.",
    placeholders: ["title", "artist"],
  },
  currentRequested: {
    default: "{title} - {artist} || requested by @{user}",
    description: "Sent by !song for a track that was requested through this bot.",
    placeholders: ["title", "artist", "user"],
  },
};

overrides.registerDefaults("song", MESSAGES);

module.exports = {
  name: "song",
  matches: (ctx) => ctx.msg === "!song",
  handle: async (ctx) => {
    if (!spotifyAuth.isConfigured()) {
      await sendBotMessage(overrides.getMessage("song", "notConfigured", MESSAGES.notConfigured.default), ctx.messageId);
      return;
    }

    let playback;
    try {
      playback = await spotify.getPlaybackState();
    } catch (e) {
      console.error("[SONGREQ] !song playback lookup failed:", e.response?.data || e.message);
      playback = null;
    }

    if (!playback || !playback.item) {
      await sendBotMessage(overrides.getMessage("song", "nothingPlaying", MESSAGES.nothingPlaying.default), ctx.messageId);
      return;
    }

    const title = playback.item.name;
    const artist = (playback.item.artists || []).map((a) => a.name).join(", ");

    const requester = findRequesterForTrack(playback.item.uri);

    if (requester) {
      await sendBotMessage(
        overrides.getMessage("song", "currentRequested", MESSAGES.currentRequested.default, {
          title,
          artist,
          user: requester,
        }),
        ctx.messageId
      );
    } else {
      await sendBotMessage(
        overrides.getMessage("song", "current", MESSAGES.current.default, { title, artist }),
        ctx.messageId
      );
    }
  },
};
