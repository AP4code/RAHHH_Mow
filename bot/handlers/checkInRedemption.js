const settingsStore = require("../lib/persistence/checkInSettings");
const snacksStore = require("../lib/persistence/snacks");
const { sendStreamerChat } = require("../lib/chat");
const { fillTemplate } = require("../lib/templateFill");
const { updateRedemptionStatus } = require("../lib/twitchRewards");

/* ------------------------------------------------------------------ */
/* Daily Check-In — deliberately independent from lib/persistence/       */
/* redeems.js and the Redeems page/handlers/redemptions.js, same          */
/* reasoning as Song Requests: there's only ever one reward that can      */
/* trigger a check-in, chosen on the dedicated Daily Check-In tab.        */
/*                                                                     */
/* The confirmation is sent as the STREAMER's own account (sendStreamer  */
/* Chat), not the bot — this replaces the old passive mechanism that     */
/* used to mirror some other bot's chat announcement instead of owning   */
/* the data itself (see the now-removed maybeRecordUpdate in             */
/* lib/persistence/snacks.js).                                          */
/* ------------------------------------------------------------------ */

async function handleCheckInRedemption(event) {
  const settings = settingsStore.settings;
  if (!settings.enabled || !settings.redeemId) return;

  const rewardId = event.reward?.id;
  if (rewardId !== settings.redeemId) return;

  const login = event.user_login;
  const amount = settings.pointsPerCheckIn || 1;
  const value = (snacksStore.snacks[login] ?? 0) + amount;
  snacksStore.snacks[login] = value;
  snacksStore.save();

  try {
    await updateRedemptionStatus(rewardId, event.id, "FULFILLED");
  } catch (e) {
    console.error(
      "[CHECKIN] Failed to mark redemption fulfilled — likely not queued (Skip Reward Queue is on):",
      e.response?.data || e.message
    );
  }

  const text = settings.message || "{user} just checked in! They now have {value} check-in point(s).";
  await sendStreamerChat(fillTemplate(text, { user: login, value }));
}

module.exports = { handleCheckInRedemption };
