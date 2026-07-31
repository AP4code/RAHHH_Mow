// Command registry — dispatch is first-match-wins, mirroring how the old
// monolithic if/else chain worked. Order only matters for messages that
// could match more than one command (rare, since triggers are distinct
// prefixes), but it's kept explicit here rather than derived from directory
// listing order so precedence is obvious at a glance.
//
// To add a new command with real logic (cooldowns, permissions, API calls,
// state): create commands/yourCommand.js exporting
// { name, matches(ctx), handle(ctx) }, then require() it below.
//
// Plain streamer-authored commands (simple replies, counters) don't need a
// file at all anymore — they're data, created via the Command Maker UI (or
// by hand-editing data/customCommands.json) and served by ./customCommands,
// which is why it's kept last: built-in commands always take precedence
// over anything a custom command might collide with.
const commands = [
  require("./w"),
  require("./ssnacks"),
  require("./topsnacks"),
  require("./forcereset"),
  require("./note"),
  require("./time"),
  require("./clip"),
  require("./repeat"),
  require("./shoutout"),
  require("./coinPause"),
  require("./coin"),
  require("./songRequest"),
  require("./removeRequest"),
  require("./skip"),
  require("./song"),
  require("./queue"),
  require("./next"),
  require("./add"),
  require("./startWordle"),
  require("./wordlePause"),
  require("./wordlePlay"),
  require("./wordleReset"),
  require("./wordleTopWins"),
  require("./wordleHelp"),
  require("./customCommands"),
];

async function dispatch(ctx) {
  for (const cmd of commands) {
    if (cmd.matches(ctx)) {
      await cmd.handle(ctx);
      return true;
    }
  }
  return false;
}

module.exports = { dispatch };
