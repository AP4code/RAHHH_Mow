const state = require("../lib/state");
const { TARGET_CHANNEL_LOGIN } = require("../lib/env");
const commands = require("../commands");
const shoutouts = require("../lib/shoutouts");
const cointoss = require("../lib/games/coinToss");

function badgeSet(event) {
  return new Set((event.badges || []).map((b) => b.set_id));
}

async function onChatMessage(event) {
  // ignore our own messages (replaces tmi's `self` flag)
  if (event.chatter_user_id === state.botUserId) return;

  const login = (event.chatter_user_login || "").toLowerCase();
  const message = event.message?.text ?? "";
  const messageId = event.message_id;
  const badges = badgeSet(event);

  const isBroadcaster = badges.has("broadcaster");
  const isMod = badges.has("moderator");
  const isVip = badges.has("vip");
  // "founder" is Twitch's legacy badge for early subscribers — functionally
  // still a subscriber, so it counts too.
  const isSubscriber = badges.has("subscriber") || badges.has("founder");
  const isModOrBroadcaster = isMod || isBroadcaster;
  const msg = message.trim().toLowerCase();

  const ctx = {
    login,
    userId: event.chatter_user_id,
    message,
    msg,
    messageId,
    isBroadcaster,
    isMod,
    isVip,
    isSubscriber,
    isModOrBroadcaster,
    event,
  };

  if (await commands.dispatch(ctx)) return;

  if (!login || login === TARGET_CHANNEL_LOGIN.toLowerCase()) return;

  // Passive tail logic — only for messages that didn't match a command.
  shoutouts.maybeQueueVipShoutout(login);
  shoutouts.registerChatActivity(login);
  cointoss.trackActivity(login);
}

module.exports = { onChatMessage };
