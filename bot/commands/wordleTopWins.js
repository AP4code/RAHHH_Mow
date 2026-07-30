const wordle = require("../lib/games/wordle");

module.exports = {
  name: "wordleTopWins",
  matches: (ctx) => ctx.msg === "!topwins",
  handle: async () => {
    await wordle.sendTopWins();
  },
};
