const moment = require("moment-timezone");
const { sendBotMessage } = require("../lib/chat");
const { RESOLVED_TIMEZONE } = require("../lib/env");
const state = require("../lib/state");
const overrides = require("../lib/messageOverrides");

const MESSAGES = {
  reply: {
    default: "Current time for {streamer}: {time}",
    description: "Sent in response to !time.",
    placeholders: ["streamer", "time"],
  },
};

overrides.registerDefaults("time", MESSAGES);

module.exports = {
  name: "time",
  matches: (ctx) => ctx.msg === "!time",
  handle: async () => {
    // moment-timezone, not the bundled Node runtime's built-in Intl/ICU —
    // see lib/env.js for why (stale tzdata baked into the node.exe binary).
    const time = moment().tz(RESOLVED_TIMEZONE).format("h:mm A");
    const streamer = state.broadcasterDisplayName || "the streamer";

    await sendBotMessage(overrides.getMessage("time", "reply", MESSAGES.reply.default, { time, streamer }));
  },
};
