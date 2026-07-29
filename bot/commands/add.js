const { sendBotMessage } = require("../lib/chat");
const spotify = require("../lib/spotify");
const spotifyAuth = require("../lib/spotifyAuth");
const settingsStore = require("../lib/persistence/songSettings");
const overrides = require("../lib/messageOverrides");

/* ------------------------------------------------------------------ */
/* !add — mod/broadcaster only. Adds whatever's currently playing to the */
/* Spotify playlist configured in songSettings.addToPlaylistId, regardless */
/* of whether it came from a song request, Spotify's own queue, or smart   */
/* shuffle — replaces the old behavior of silently adding every promoted   */
/* request to the playlist automatically.                                */
/* ------------------------------------------------------------------ */

const MESSAGES = {
  notConfigured: {
    default: "Spotify isn't connected yet.",
    description: "Sent when !add is used but Spotify hasn't been connected.",
    placeholders: [],
  },
  noPlaylist: {
    default: "No playlist is set — add a playlist ID in Song Requests settings first.",
    description: "Sent when !add is used but no playlist ID is configured.",
    placeholders: [],
  },
  nothingPlaying: {
    default: "Nothing's playing right now.",
    description: "Sent when !add is used but Spotify has no active playback.",
    placeholders: [],
  },
  added: {
    default: '@{login} added "{title}" by {artist} to the playlist!',
    description: "Sent when !add successfully adds the current song to the playlist.",
    placeholders: ["login", "title", "artist"],
  },
  failed: {
    default: "@{login} couldn't add that to the playlist, check the playlist ID and permissions.",
    description: "Sent when the Spotify API call to add the track fails.",
    placeholders: ["login"],
  },
};

overrides.registerDefaults("add", MESSAGES);

module.exports = {
  name: "add",
  matches: (ctx) => ctx.isModOrBroadcaster && ctx.msg === "!add",
  handle: async (ctx) => {
    if (!spotifyAuth.isConfigured()) {
      await sendBotMessage(overrides.getMessage("add", "notConfigured", MESSAGES.notConfigured.default), ctx.messageId);
      return;
    }

    const playlistId = settingsStore.settings.addToPlaylistId;
    if (!playlistId) {
      await sendBotMessage(overrides.getMessage("add", "noPlaylist", MESSAGES.noPlaylist.default), ctx.messageId);
      return;
    }

    let playback;
    try {
      playback = await spotify.getPlaybackState();
    } catch (e) {
      console.error("[SONGREQ] !add playback lookup failed:", e.response?.data || e.message);
      playback = null;
    }

    if (!playback || !playback.item) {
      await sendBotMessage(overrides.getMessage("add", "nothingPlaying", MESSAGES.nothingPlaying.default), ctx.messageId);
      return;
    }

    try {
      await spotify.addToPlaylist(playlistId, playback.item.uri);
    } catch (e) {
      console.error("[SONGREQ] !add failed to add to playlist:", e.response?.data || e.message);
      await sendBotMessage(
        overrides.getMessage("add", "failed", MESSAGES.failed.default, { login: ctx.login }),
        ctx.messageId
      );
      return;
    }

    await sendBotMessage(
      overrides.getMessage("add", "added", MESSAGES.added.default, {
        login: ctx.login,
        title: playback.item.name,
        artist: (playback.item.artists || []).map((a) => a.name).join(", "),
      }),
      ctx.messageId
    );
  },
};
