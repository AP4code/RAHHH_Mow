const { sendBotMessage } = require("../lib/chat");
const { snacks } = require("../lib/persistence/snacks");
const overrides = require("../lib/messageOverrides");

const MESSAGES = {
  empty: {
    default: "No snacks have been recorded yet missmeowAlbiSadge ",
    description: "Sent when nobody has any recorded snacks yet.",
    placeholders: [],
  },
  leaderboard: {
    default: "Top Smoky Snack enjoyers 🍿 → {list} missmeowMeowSmokyYay",
    description: "Sent with the top 3 snack counts. {list} is the ranked \"1. user (count) | 2. ...\" text.",
    placeholders: ["list"],
  },
};

overrides.registerDefaults("topsnacks", MESSAGES);

module.exports = {
  name: "topsnacks",
  matches: (ctx) => ctx.msg === "!topsnacks",
  handle: async (ctx) => {
    const entries = Object.entries(snacks);

    if (entries.length === 0) {
      await sendBotMessage(overrides.getMessage("topsnacks", "empty", MESSAGES.empty.default, {}));
      return;
    }

    const top = entries.sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.log(`[SNACKS] !topsnacks requested by ${ctx.login}:`, top.map(([u, c]) => `${u}(${c})`).join(", "));

    const list = top.map(([user, count], i) => `${i + 1}. ${user} (${count})`).join(" | ");
    await sendBotMessage(overrides.getMessage("topsnacks", "leaderboard", MESSAGES.leaderboard.default, { list }));
  },
};
