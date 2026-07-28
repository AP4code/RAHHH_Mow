const cointoss = require("../lib/games/coinToss");
const { sendBotMessage } = require("../lib/chat");
const overrides = require("../lib/messageOverrides");

const MESSAGES = {
  resumed: {
    default: "🪙 Coin toss events resumed!",
    description: "Sent when a mod/broadcaster re-enables coin toss events with !p.",
    placeholders: [],
  },
  paused: {
    default: "⏸️ Coin toss events paused.",
    description: "Sent when a mod/broadcaster disables coin toss events with !p.",
    placeholders: [],
  },
};

overrides.registerDefaults("coinPause", MESSAGES);

module.exports = {
  name: "coinPause",
  matches: (ctx) => ctx.isModOrBroadcaster && ctx.msg === "!p",
  handle: async () => {
    const next = !cointoss.isEnabled();
    cointoss.setEnabled(next);

    const key = next ? "resumed" : "paused";
    await sendBotMessage(overrides.getMessage("coinPause", key, MESSAGES[key].default, {}));
  },
};
