const { sendBotMessage } = require("../lib/chat");
const queueStore = require("../lib/persistence/songQueue");
const overrides = require("../lib/messageOverrides");
const { updateRedemptionStatus } = require("../lib/twitchRewards");

/* ------------------------------------------------------------------ */
/* !remove — only works on a request that's still "pending" (not yet     */
/* pushed into Spotify's real queue by lib/songQueueScheduler.js). Once   */
/* it's "sent", Spotify's queue API has no removal endpoint, so there's   */
/* nothing left this command can do about it.                          */
/*                                                                     */
/* A still-pending channel-points request hasn't been marked "FULFILLED" */
/* yet either (see handlers/songRequestRedemption.js) — removing it here  */
/* cancels the redemption too, which is what actually triggers Twitch's   */
/* automatic point refund.                                             */
/* ------------------------------------------------------------------ */

const MESSAGES = {
  removed: {
    default: '@{login} removed "{title}" from the queue.',
    description: "Sent when !remove successfully cancels a still-pending request.",
    placeholders: ["login", "title"],
  },
  notFound: {
    default: "@{login} there's no removable request in the queue right now.",
    description: "Sent when !remove finds no matching request at all.",
    placeholders: ["login"],
  },
  alreadySent: {
    default: "@{login} that request already joined Spotify's queue — can't remove it now.",
    description: "Sent when the matching request's status is no longer \"pending\".",
    placeholders: ["login"],
  },
  noPermission: {
    default: "@{login} only a moderator can remove someone else's request.",
    description: "Sent when a non-mod tries !remove <username>.",
    placeholders: ["login"],
  },
};

overrides.registerDefaults("removeRequest", MESSAGES);

module.exports = {
  name: "removeRequest",
  matches: (ctx) => ctx.msg === "!remove" || ctx.msg.startsWith("!remove "),
  handle: async (ctx) => {
    const arg = ctx.message.trim().slice("!remove".length).trim();
    let targetLogin = ctx.login;

    if (arg) {
      if (!ctx.isModOrBroadcaster) {
        await sendBotMessage(
          overrides.getMessage("removeRequest", "noPermission", MESSAGES.noPermission.default, { login: ctx.login }),
          ctx.messageId
        );
        return;
      }
      targetLogin = arg.replace(/^@/, "").toLowerCase();
    }

    const candidates = queueStore.queue.filter((r) => r.requestedBy.toLowerCase() === targetLogin.toLowerCase());

    if (!candidates.length) {
      await sendBotMessage(
        overrides.getMessage("removeRequest", "notFound", MESSAGES.notFound.default, { login: ctx.login }),
        ctx.messageId
      );
      return;
    }

    const latest = candidates[candidates.length - 1];

    if (latest.status !== "pending") {
      await sendBotMessage(
        overrides.getMessage("removeRequest", "alreadySent", MESSAGES.alreadySent.default, { login: ctx.login }),
        ctx.messageId
      );
      return;
    }

    const idx = queueStore.queue.indexOf(latest);
    queueStore.queue.splice(idx, 1);
    queueStore.save();

    if (latest.rewardId && latest.redemptionId) {
      try {
        await updateRedemptionStatus(latest.rewardId, latest.redemptionId, "CANCELED");
      } catch (e) {
        console.error("[SONGREQ] Failed to refund removed redemption:", e.response?.data || e.message);
      }
    }

    await sendBotMessage(
      overrides.getMessage("removeRequest", "removed", MESSAGES.removed.default, {
        login: ctx.login,
        title: latest.title,
      }),
      ctx.messageId
    );
  },
};
