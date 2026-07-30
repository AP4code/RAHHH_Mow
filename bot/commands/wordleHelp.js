const wordle = require("../lib/games/wordle");

module.exports = {
  name: "wordleHelp",
  matches: (ctx) => ctx.msg === "!help",
  handle: async () => {
    await wordle.sendHelp();
  },
};
