const wordle = require("../lib/games/wordle");

module.exports = {
  name: "wordlePlay",
  matches: (ctx) => ctx.isModOrBroadcaster && (ctx.msg === "!play" || ctx.msg === "!resume"),
  handle: async (ctx) => {
    await wordle.resume(ctx.login);
  },
};
