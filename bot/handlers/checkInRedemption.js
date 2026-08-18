const settingsStore = require("../lib/persistence/checkInSettings");
const snacksStore = require("../lib/persistence/snacks");
const { sendAs } = require("../lib/chat");
const { fillTemplate } = require("../lib/templateFill");
const { updateRedemptionStatus } = require("../lib/twitchRewards");

/* ------------------------------------------------------------------ */
/* Daily Check-In — deliberately independent from lib/persistence/       */
/* redeems.js and the Redeems page/handlers/redemptions.js, same          */
/* reasoning as Song Requests: there's only ever one reward that can      */
/* trigger a check-in, chosen on the dedicated Daily Check-In tab.        */
/*                                                                     */
/* The confirmation's sender account (settings.sendAs) is streamer by     */
/* default — this replaces the old passive mechanism that used to mirror  */
/* some other bot's chat announcement instead of owning the data itself   */
/* (see the now-removed maybeRecordUpdate in lib/persistence/snacks.js). */
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

  const vars = { user: login, value };
  const line1 = settings.message || "{user} has checked in! Thank you for being here! <3";
  const line2 = settings.message2 || "{user} now has {value} delicious Smoky snack(s)!";
  await sendAs(settings.sendAs || "streamer", fillTemplate(line1, vars));
  await sendAs(settings.sendAs || "streamer", fillTemplate(line2, vars));
}

module.exports = { handleCheckInRedemption };
