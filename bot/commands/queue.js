const { sendBotMessage } = require("../lib/chat");
const spotifyAuth = require("../lib/spotifyAuth");
const settingsStore = require("../lib/persistence/songSettings");
const { getUpcoming } = require("../lib/upcomingSongs");
const overrides = require("../lib/messageOverrides");

/* ------------------------------------------------------------------ */
/* !queue — lists upcoming songs, this app's own pending requests first,  */
/* then Spotify's own device queue (see lib/upcomingSongs.js). Capped at  */
/* songSettings.queueDisplayCount by default; "!queue N" overrides that   */
/* for just that call.                                                 */
/* ------------------------------------------------------------------ */

const MESSAGES = {
  notConfigured: {
    default: "Spotify isn't connected yet.",
    description: "Sent when !queue is used but Spotify hasn't been connected.",
    placeholders: [],
  },
  empty: {
    default: "Nothing's queued up right now.",
    description: "Sent when !queue finds no pending requests or Spotify queue.",
    placeholders: [],
  },
  list: {
    default: "Up next: {list}",
    description: "Sent by !queue with the merged upcoming song list.",
    placeholders: ["list"],
  },
};

overrides.registerDefaults("queue", MESSAGES);

// Ignores a garbage/zero/negative argument rather than erroring — falls
// back to the configured default the same as no argument at all. Capped at
// 20 so someone typing "!queue 999" can't blow out the chat message.
function resolveCount(arg, fallback) {
  const n = parseInt(arg, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 20);
}

module.exports = {
  name: "queue",
  matches: (ctx) => ctx.msg === "!queue" || ctx.msg.startsWith("!queue "),
  handle: async (ctx) => {
    if (!spotifyAuth.isConfigured()) {
      await sendBotMessage(overrides.getMessage("queue", "notConfigured", MESSAGES.notConfigured.default), ctx.messageId);
      return;
    }

    const arg = ctx.message.trim().slice("!queue".length).trim();
    const count = resolveCount(arg, settingsStore.settings.queueDisplayCount || 4);

    const upcoming = await getUpcoming();
    if (!upcoming.length) {
      await sendBotMessage(overrides.getMessage("queue", "empty", MESSAGES.empty.default), ctx.messageId);
      return;
    }

    const list = upcoming
      .slice(0, count)
      .map((s, i) => {
        const label = `${i + 1}. ${s.title} - ${s.artist}`;
        return s.requestedBy ? `${label} (req. @${s.requestedBy})` : label;
      })
      .join(" | ");

    await sendBotMessage(overrides.getMessage("queue", "list", MESSAGES.list.default, { list }), ctx.messageId);
  },
};
