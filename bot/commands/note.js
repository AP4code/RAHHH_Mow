const axios = require("axios");
const { sendBotMessage } = require("../lib/chat");
const overrides = require("../lib/messageOverrides");

const MESSAGES = {
  missingText: {
    default: "@{login} Please provide what to note, right after the command !note",
    description: "Sent when !note is used with no text after it.",
    placeholders: ["login"],
  },
  success: {
    default: "@{login} Thank You for the note!",
    description: "Sent once the note was posted to Discord successfully.",
    placeholders: ["login"],
  },
  failure: {
    default: "@{login} couldn't send note...blyat",
    description: "Sent if posting the note to Discord failed.",
    placeholders: ["login"],
  },
};

overrides.registerDefaults("note", MESSAGES);

module.exports = {
  name: "note",
  matches: (ctx) => ctx.msg.startsWith("!note"),
  handle: async (ctx) => {
    if (!(ctx.isMod || ctx.isBroadcaster || ctx.isVip)) return;

    const noteText = ctx.message.slice(5).trim();

    if (!noteText) {
      await sendBotMessage(
        overrides.getMessage("note", "missingText", MESSAGES.missingText.default, { login: ctx.login }),
        ctx.messageId
      );
      return;
    }

    try {
      await axios.post(process.env.DISCORD_WEBHOOK_URL, {
        content: `**From-${ctx.login}**\n${noteText}`,
      });

      console.log(`[NOTE] ${ctx.login}: ${noteText}`);
      await sendBotMessage(
        overrides.getMessage("note", "success", MESSAGES.success.default, { login: ctx.login }),
        ctx.messageId
      );
    } catch (err) {
      console.error("[NOTE] Failed:", err.message);
      await sendBotMessage(
        overrides.getMessage("note", "failure", MESSAGES.failure.default, { login: ctx.login }),
        ctx.messageId
      );
    }
  },
};
