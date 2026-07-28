const sessionStore = require("../lib/persistence/session");

module.exports = {
  name: "forcereset",
  matches: (ctx) => ctx.isModOrBroadcaster && ctx.msg === "!forcereset",
  handle: async () => {
    sessionStore.reset("manual command");
  },
};
