const { sendBotMessage } = require("../lib/chat");
const spotifyAuth = require("../lib/spotifyAuth");
const { getUpcoming } = require("../lib/upcomingSongs");
const overrides = require("../lib/messageOverrides");

/* ------------------------------------------------------------------ */
/* !next — just the first entry of the same merged list !queue builds     */
/* (see lib/upcomingSongs.js).                                         */
/* ------------------------------------------------------------------ */

const MESSAGES = {
  notConfigured: {
    default: "Spotify isn't connected yet.",
    description: "Sent when !next is used but Spotify hasn't been connected.",
    placeholders: [],
  },
  empty: {
    default: "Nothing's queued up next.",
    description: "Sent when !next finds no pending requests or Spotify queue.",
    placeholders: [],
  },
  next: {
    default: "Up next: {title} - {artist}",
    description: "Sent by !next for a track that wasn't requested through this bot.",
    placeholders: ["title", "artist"],
  },
  nextRequested: {
    default: "Up next: {title} - {artist} (req. @{user})",
    description: "Sent by !next for a track that was requested through this bot.",
    placeholders: ["title", "artist", "user"],
  },
};

overrides.registerDefaults("next", MESSAGES);

module.exports = {
  name: "next",
  matches: (ctx) => ctx.msg === "!next",
  handle: async (ctx) => {
    if (!spotifyAuth.isConfigured()) {
      await sendBotMessage(overrides.getMessage("next", "notConfigured", MESSAGES.notConfigured.default), ctx.messageId);
      return;
    }

    const upcoming = await getUpcoming();
    if (!upcoming.length) {
      await sendBotMessage(overrides.getMessage("next", "empty", MESSAGES.empty.default), ctx.messageId);
      return;
    }

    const next = upcoming[0];
    if (next.requestedBy) {
      await sendBotMessage(
        overrides.getMessage("next", "nextRequested", MESSAGES.nextRequested.default, {
          title: next.title,
          artist: next.artist,
          user: next.requestedBy,
        }),
        ctx.messageId
      );
    } else {
      await sendBotMessage(
        overrides.getMessage("next", "next", MESSAGES.next.default, { title: next.title, artist: next.artist }),
        ctx.messageId
      );
    }
  },
};
