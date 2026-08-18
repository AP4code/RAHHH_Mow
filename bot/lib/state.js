// Shared runtime identity, resolved once at bootstrap (see bot.js) and read
// by every module that needs to know who we are. Plain mutable object so all
// requires of this module see the same live values — don't reassign the
// module.exports object itself, only its fields.
module.exports = {
  broadcasterId: null,
  broadcasterDisplayName: null, // properly-cased, e.g. "MissMeowZaki" — for user-facing text like !time
  botUserId: null,
  botLogin: null, // cheesybot's login, lowercased
  modUserId: null,
  modLogin: null, // smoothcheese01's login, lowercased
};
