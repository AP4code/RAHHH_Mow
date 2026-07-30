const wordle = require("../lib/games/wordle");
const settingsStore = require("../lib/persistence/wordleSettings");

/* ------------------------------------------------------------------ */
/* !sw (configurable, see Wordle settings) — mod/broadcaster only. Top-  */
/* level on/off toggle for the whole game, distinct from !pause/!play    */
/* which only freeze/resume the current round. Chat confirmation is       */
/* sent from inside wordle.toggle() itself since it already knows which  */
/* message applies.                                                    */
/* ------------------------------------------------------------------ */

module.exports = {
  name: "startWordle",
  matches: (ctx) => {
    if (!ctx.isModOrBroadcaster) return false;
    const trigger = (settingsStore.settings.chatCommand || "!sw").toLowerCase();
    return ctx.msg === trigger;
  },
  handle: async () => {
    await wordle.toggle();
  },
};
