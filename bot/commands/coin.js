const cointoss = require("../lib/games/coinToss");

module.exports = {
  name: "coin",
  matches: (ctx) => ctx.msg.startsWith("!coin"),
  handle: async (ctx) => {
    const choice = ctx.msg.split(/\s+/)[1];
    await cointoss.handleChoice(ctx.login, choice);
  },
};
