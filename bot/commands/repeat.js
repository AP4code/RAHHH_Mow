const { sendChat, getLastBotMessage } = require("../lib/chat");

module.exports = {
  name: "repeat",
  matches: (ctx) => ctx.isModOrBroadcaster && ctx.msg === "!repeat",
  handle: async () => {
    const last = getLastBotMessage();
    if (last) await sendChat(last);
  },
};
