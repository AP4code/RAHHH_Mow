const { sendBotMessage } = require("../lib/chat");
const overrides = require("../lib/messageOverrides");

const MESSAGES = {
  reply: {
    default: "W W W W W W W",
    description: "Sent when someone chats a message that's just repeated \"w\"s.",
    placeholders: [],
  },
};

overrides.registerDefaults("w", MESSAGES);

module.exports = {
  name: "w",
  matches: (ctx) => /^(w\s*)+$/i.test(ctx.message.trim()),
  handle: async () => {
    await sendBotMessage(overrides.getMessage("w", "reply", MESSAGES.reply.default, {}));
  },
};
