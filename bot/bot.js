require("./lib/env"); // must load first — populates process.env before anything else reads it

const state = require("./lib/state");
const auth = require("./lib/auth");
const { TARGET_CHANNEL_LOGIN } = require("./lib/env");
const sessionStore = require("./lib/persistence/session");
const lists = require("./lib/persistence/lists");
const snacksStore = require("./lib/persistence/snacks");
const customCommandsStore = require("./lib/persistence/customCommands");
const redeemsStore = require("./lib/persistence/redeems");
const songQueueStore = require("./lib/persistence/songQueue");
const songSettingsStore = require("./lib/persistence/songSettings");
const songBlocklistStore = require("./lib/persistence/songBlocklist");
const nowPlayingStore = require("./lib/persistence/nowPlaying");
const checkInSettingsStore = require("./lib/persistence/checkInSettings");
const spotifyAuth = require("./lib/spotifyAuth");
const songQueueScheduler = require("./lib/songQueueScheduler");
const sfxServer = require("./lib/sfxServer");
const messageOverrides = require("./lib/messageOverrides");
const shoutouts = require("./lib/shoutouts");
const cointoss = require("./lib/games/coinToss");
const eventsub = require("./lib/eventsub");
const notifications = require("./handlers/notifications");

process.on("unhandledRejection", (err) => {
  console.error("UnhandledPromiseRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("UncaughtException:", err);
});

const PROCESS_INTERVAL_MS = 5000;
const TOKEN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const SPOTIFY_POLL_INTERVAL_MS = 3000;

/* ------------------------------------------------------------------ */
/* EventSub wiring                                                     */
/*                                                                     */
/* Twitch rule: a single websocket session may only carry              */
/* subscriptions created by ONE user's token. So we run two            */
/* independent connections:                                            */
/*   chat    -> authorized by cheesybot   (channel.chat.message)       */
/*   channel -> authorized by the streamer (raid, stream on/off)       */
/* ------------------------------------------------------------------ */

const chatConnection = eventsub.createEventSubConnection({
  label: "chat",
  tokenSet: auth.botToken,
  subscriptions: () => ([
    {
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: state.broadcasterId, user_id: state.botUserId },
    },
  ]),
  onNotification: notifications.handle,
});

const channelConnection = eventsub.createEventSubConnection({
  label: "channel",
  tokenSet: auth.streamerToken,
  subscriptions: () => ([
    { type: "channel.raid", version: "1", condition: { to_broadcaster_user_id: state.broadcasterId } },
    { type: "stream.online", version: "1", condition: { broadcaster_user_id: state.broadcasterId } },
    { type: "stream.offline", version: "1", condition: { broadcaster_user_id: state.broadcasterId } },
    // Optional: needs channel:manage:redemptions on the streamer token —
    // the in-app Streamer Connect button requests this by default now, but
    // marked optional anyway so an older/manually-pasted token missing the
    // scope doesn't block the other (required) channel subscriptions.
    {
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: state.broadcasterId },
      optional: true,
    },
  ]),
  onNotification: notifications.handle,
});

process.on("SIGINT", () => {
  eventsub.shutdown();
  process.exit(0);
});

(async () => {
  lists.loadAllowlist();
  lists.loadViplist();
  lists.watch();
  sessionStore.load();
  snacksStore.load();
  customCommandsStore.loadCommands();
  customCommandsStore.loadCounters();
  customCommandsStore.watch();
  redeemsStore.loadRedeems();
  redeemsStore.watch();
  songQueueStore.resetQueue();
  songQueueStore.watch();
  songSettingsStore.loadSettings();
  songSettingsStore.watch();
  songBlocklistStore.loadBlocklist();
  songBlocklistStore.watch();
  nowPlayingStore.ensureFile();
  checkInSettingsStore.loadSettings();
  checkInSettingsStore.watch();
  sfxServer.start();
  // Every command module has already registered its editable messages by
  // this point (they were all require()'d transitively above), so the
  // catalog this writes is complete.
  messageOverrides.init();

  await auth.refreshAll();
  if (spotifyAuth.isConfigured()) await spotifyAuth.refresh().catch(() => {});

  if (!auth.botToken.accessToken || !auth.streamerToken.accessToken || !auth.modToken.accessToken) {
    console.error("Missing one or more access tokens after refresh. Exiting.");
    process.exit(1);
  }

  const [botSelf, streamerSelf, modSelf] = await Promise.all([
    auth.getSelfUser(auth.botToken),
    auth.getSelfUser(auth.streamerToken),
    auth.getSelfUser(auth.modToken),
  ]);

  if (!botSelf || !streamerSelf || !modSelf) {
    console.error("Could not resolve one or more token identities. Check scopes/tokens. Exiting.");
    process.exit(1);
  }

  state.botUserId = botSelf.id;
  state.broadcasterId = streamerSelf.id;
  state.broadcasterDisplayName = streamerSelf.display_name || streamerSelf.login;
  state.botLogin = botSelf.login.toLowerCase();
  state.modLogin = modSelf.login.toLowerCase();

  auth.cacheUserId(botSelf.login, botSelf.id);
  auth.cacheUserId(streamerSelf.login, streamerSelf.id);

  console.log(`[TWITCH] Bot (chat): ${botSelf.login} (${state.botUserId})`);
  console.log(`[TWITCH] Streamer (shoutouts + lookups): ${streamerSelf.login} (${state.broadcasterId})`);
  console.log(`[TWITCH] Mod (clips only): ${modSelf.login} (${modSelf.id})`);

  if (streamerSelf.login.toLowerCase() !== TARGET_CHANNEL_LOGIN.toLowerCase()) {
    console.warn(
      `[TWITCH] STREAMER token belongs to "${streamerSelf.login}" but TARGET_CHANNEL_LOGIN is "${TARGET_CHANNEL_LOGIN}" — double check your tokens.`
    );
  }

  const live = await auth.isChannelLive(state.broadcasterId, auth.streamerToken);
  if (!live) sessionStore.reset("cleared (channel offline at startup)");
  sessionStore.session.live = live;
  sessionStore.save();

  chatConnection.connect();
  channelConnection.connect();

  try {
    await Promise.all([chatConnection.ready, channelConnection.ready]);
  } catch (err) {
    console.error(`[EVENTSUB] Startup aborted — ${err.message}`);
    eventsub.shutdown();
    process.exit(1);
  }

  console.log(`Listening in #${TARGET_CHANNEL_LOGIN} via EventSub …`);

  setInterval(shoutouts.processCandidates, PROCESS_INTERVAL_MS);
  cointoss.start();
  setInterval(() => {
    auth.refreshAll();
    if (spotifyAuth.isConfigured()) spotifyAuth.refresh().catch(() => {});
  }, TOKEN_REFRESH_INTERVAL_MS);

  // Also drives promoting the next pending song request into Spotify's real
  // queue a few seconds before the current track ends — see
  // lib/songQueueScheduler.js. 3s keeps that promotion reasonably close to
  // on-time without hammering Spotify's API.
  setInterval(() => songQueueScheduler.tick(), SPOTIFY_POLL_INTERVAL_MS);
})();
