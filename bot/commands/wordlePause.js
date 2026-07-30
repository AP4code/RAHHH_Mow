const wordle = require("../lib/games/wordle");

module.exports = {
  name: "wordlePause",
  matches: (ctx) => ctx.isModOrBroadcaster && ctx.msg === "!pause",
  handle: async (ctx) => {
    await wordle.pause(ctx.login);
  },
};
