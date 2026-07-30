const wordle = require("../lib/games/wordle");

module.exports = {
  name: "wordleReset",
  matches: (ctx) => ctx.isModOrBroadcaster && (ctx.msg === "!reset" || ctx.msg === "!restart"),
  handle: async (ctx) => {
    await wordle.resetRound(ctx.login);
  },
};
