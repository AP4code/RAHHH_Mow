const { sendBotMessage } = require("../lib/chat");
const { snacks } = require("../lib/persistence/snacks");
const overrides = require("../lib/messageOverrides");

const MESSAGES = {
  found: {
    default: "{target} has {count} Smoky snack(s)! missmeowMeowSmokyWow ",
    description: "Sent when the target user has a recorded snack count.",
    placeholders: ["target", "count"],
  },
  notFound: {
    default: "{target} doesn't have any Smoky snacks yet missmeowAlbiSadge ",
    description: "Sent when the target user has no recorded snacks.",
    placeholders: ["target"],
  },
};

overrides.registerDefaults("ssnacks", MESSAGES);

module.exports = {
  name: "ssnacks",
  matches: (ctx) => ctx.msg.startsWith("!ssnacks"),
  handle: async (ctx) => {
    const parts = ctx.message.trim().split(/\s+/);
    let target = ctx.login;
    if (parts[1]) target = parts[1].replace(/^@/, "").toLowerCase();

    const count = snacks[target];
    console.log(`[SNACKS] ${ctx.login} checked snacks for ${target}: ${count ?? "none"}`);

    if (count !== undefined) {
      await sendBotMessage(overrides.getMessage("ssnacks", "found", MESSAGES.found.default, { target, count }));
    } else {
      await sendBotMessage(overrides.getMessage("ssnacks", "notFound", MESSAGES.notFound.default, { target }));
    }
  },
};
