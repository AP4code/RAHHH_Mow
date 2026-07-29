const { sendBotMessage } = require("../lib/chat");
const settingsStore = require("../lib/persistence/songSettings");
const { requestSong } = require("../lib/songRequestCore");
const { getSubTier } = require("../lib/subscriptions");
const overrides = require("../lib/messageOverrides");

const MESSAGES = {
  success: {
    default: '@{login} added "{title}" by {artist}! missmeowOOo ',
    description: "Sent when a chat song request is accepted.",
    placeholders: ["login", "title", "artist"],
  },
  failed: {
    default: "@{login} {reason}",
    description: "Sent when a song request is rejected, from chat or a channel-points redemption.",
    placeholders: ["login", "reason"],
  },
};

overrides.registerDefaults("songRequest", MESSAGES);

function matches(ctx) {
  const settings = settingsStore.settings;
  if (!settings.chatEnabled) return false;

  const trigger = (settings.chatCommand || "!sr").toLowerCase();
  return ctx.msg === trigger || ctx.msg.startsWith(`${trigger} `);
}

// Same OR-matched gate shape as commands/customCommands.js's hasPermission —
// broadcaster always passes, everything else is whichever roles are checked
// in Settings, sub tiers are "and up". Unlike that permission system, this
// is chat-only on purpose: channel-point requests already have their own
// gate (spending real points), so they're never checked against this.
function hasChatPermission(roles) {
  if (roles.isBroadcaster) return true;

  const allowed = settingsStore.settings.chatPermissions || ["follower"];
  if (allowed.includes("follower")) return true;
  if (allowed.includes("moderator") && roles.isModerator) return true;
  if (allowed.includes("vip") && roles.isVip) return true;

  if (roles.subTier != null) {
    if (allowed.includes("subT1") && roles.subTier >= 1000) return true;
    if (allowed.includes("subT2") && roles.subTier >= 2000) return true;
    if (allowed.includes("subT3") && roles.subTier >= 3000) return true;
  }

  return false;
}

module.exports = {
  name: "songRequest",
  matches,
  handle: async (ctx) => {
    const roles = {
      isBroadcaster: ctx.isBroadcaster,
      isModerator: ctx.isMod,
      isVip: ctx.isVip,
      subTier: ctx.isSubscriber ? await getSubTier(ctx.userId) : null,
    };

    // Silent no-op for an unauthorized user — same convention
    // commands/customCommands.js already uses, avoids spamming chat with
    // "you can't do that" for what might be a deliberately restricted command.
    if (!hasChatPermission(roles)) return;

    const trigger = settingsStore.settings.chatCommand || "!sr";
    const query = ctx.message.trim().slice(trigger.length).trim();

    const result = await requestSong(query, ctx.login, "chat", roles);

    if (!result.ok) {
      await sendBotMessage(
        overrides.getMessage("songRequest", "failed", MESSAGES.failed.default, {
          login: ctx.login,
          reason: result.reason,
        }),
        ctx.messageId
      );
      return;
    }

    await sendBotMessage(
      overrides.getMessage("songRequest", "success", MESSAGES.success.default, {
        login: ctx.login,
        title: result.track.title,
        artist: result.track.artist,
      }),
      ctx.messageId
    );
  },
};

module.exports.MESSAGES = MESSAGES;
