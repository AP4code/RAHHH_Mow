const shoutouts = require("../lib/shoutouts");

module.exports = {
  name: "shoutout",
  matches: (ctx) => ctx.isModOrBroadcaster && /^!so\s+/i.test(ctx.message),
  handle: async (ctx) => {
    const user = ctx.message.split(/\s+/)[1]?.replace(/^@/, "").toLowerCase();
    if (user) await shoutouts.sendOfficialShoutout(user, "manual");
  },
};
