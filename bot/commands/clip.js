const { sendBotMessage } = require("../lib/chat");
const { createClip, renameClip } = require("../lib/clips");
const sessionStore = require("../lib/persistence/session");
const overrides = require("../lib/messageOverrides");

const CLIP_COOLDOWN_MS = 30000; // 30 seconds
const CLIP_ANNOUNCE_DELAY_MS = 10000;

// Cooldown is local to this command — nothing else needs it.
let lastClipAt = 0;

const MESSAGES = {
  cooldown: {
    default: "@{login} clip command is on cooldown ({remaining}s)",
    description: "Sent when someone uses !clip while it's still on cooldown.",
    placeholders: ["login", "remaining"],
  },
  offline: {
    default: "@{login} can't clip while the stream is offline",
    description: "Sent when !clip is used while the channel is offline.",
    placeholders: ["login"],
  },
  creating: {
    default: "@{login} — creating clip...",
    description: "Sent immediately after a clip request is accepted.",
    placeholders: ["login"],
  },
  success: {
    default: "@{login} clipped this! 🎬 {url}",
    description: "Sent once the clip has actually been created.",
    placeholders: ["login", "url"],
  },
  failed: {
    default: "@{login} couldn't create clip Sadge ",
    description: "Sent when Twitch fails to create the clip.",
    placeholders: ["login"],
  },
};

overrides.registerDefaults("clip", MESSAGES);

module.exports = {
  name: "clip",
  matches: (ctx) => ctx.msg === "!clip" || ctx.msg.startsWith("!clip "),
  handle: async (ctx) => {
    const { login, message, messageId } = ctx;
    const now = Date.now();

    if (now - lastClipAt < CLIP_COOLDOWN_MS) {
      const remaining = Math.ceil((CLIP_COOLDOWN_MS - (now - lastClipAt)) / 1000);
      console.log(`[CLIP] Cooldown active (${remaining}s left) — ${login}`);
      await sendBotMessage(
        overrides.getMessage("clip", "cooldown", MESSAGES.cooldown.default, { login, remaining }),
        messageId
      );
      return;
    }

    if (sessionStore.session.live === false) {
      console.log(`[CLIP] Skipped - channel offline (${login})`);
      await sendBotMessage(overrides.getMessage("clip", "offline", MESSAGES.offline.default, { login }), messageId);
      return;
    }

    lastClipAt = now;

    const clipName = message.trim().slice(5).trim() || null;

    console.log(`[CLIP] Requested by ${login}${clipName ? ` — name: "${clipName}"` : ""}`);
    await sendBotMessage(overrides.getMessage("clip", "creating", MESSAGES.creating.default, { login }), messageId);

    const clipId = await createClip();

    if (!clipId) {
      lastClipAt = 0; // a failed attempt shouldn't burn the cooldown
      await sendBotMessage(overrides.getMessage("clip", "failed", MESSAGES.failed.default, { login }), messageId);
      return;
    }

    if (clipName) await renameClip(clipId, clipName);

    setTimeout(() => {
      const url = `https://clips.twitch.tv/${clipId}`;
      console.log(`[CLIP] Sent → ${url}`);
      sendBotMessage(overrides.getMessage("clip", "success", MESSAGES.success.default, { login, url }));
    }, CLIP_ANNOUNCE_DELAY_MS);
  },
};
