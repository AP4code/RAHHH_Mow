const spotify = require("./spotify");
const spotifyAuth = require("./spotifyAuth");
const queueStore = require("./persistence/songQueue");
const settingsStore = require("./persistence/songSettings");
const nowPlayingStore = require("./persistence/nowPlaying");
const sfxServer = require("./sfxServer");
const { updateRedemptionStatus } = require("./twitchRewards");

/* ------------------------------------------------------------------ */
/* Drives three things off the same playback poll (see bot.js's         */
/* SPOTIFY_POLL_INTERVAL_MS interval, which calls tick() on a timer):    */
/*   1. keeps nowPlaying.json fresh for the Dashboard                    */
/*   2. pushes the same now-playing state to the optional OBS overlay    */
/*      (sfxServer's /nowplaying route — only does anything if someone   */
/*      actually has that browser source open)                          */
/*   3. pushes the next "pending" request into Spotify's real queue a    */
/*      few seconds before the currently playing track ends              */
/*                                                                     */
/* That delay is deliberate — Spotify's queue API has no "remove"        */
/* endpoint, so a request only stays cancelable (via !remove) while it's  */
/* still "pending" here rather than already sent to Spotify.             */
/* ------------------------------------------------------------------ */

// Guards against re-promoting on every tick while the same track lingers in
// its final few seconds — reset whenever the currently playing track's id
// changes, so the next track gets its own fresh promotion opportunity.
let promotedForTrackId = null;

async function tick() {
  if (!spotifyAuth.isConfigured()) return;

  let playback;
  try {
    playback = await spotify.getPlaybackState();
  } catch (e) {
    console.error("[SONGREQ] Playback poll failed:", e.response?.data || e.message);
    return;
  }

  if (!playback || !playback.item) {
    nowPlayingStore.save(null);
    sfxServer.pushNowPlaying(null);
    return;
  }

  const nowPlaying = {
    title: playback.item.name,
    artist: (playback.item.artists || []).map((a) => a.name).join(", "),
    isPlaying: playback.is_playing,
    progressMs: playback.progress_ms,
    durationMs: playback.item.duration_ms,
    albumArt: playback.item.album?.images?.[0]?.url || null,
  };
  nowPlayingStore.save(nowPlaying);
  sfxServer.pushNowPlaying(nowPlaying);

  if (playback.item.id !== promotedForTrackId) {
    promotedForTrackId = null;
  }

  if (!playback.is_playing) return;
  if (promotedForTrackId === playback.item.id) return; // already handled this track

  const remainingMs = playback.item.duration_ms - playback.progress_ms;
  const thresholdMs = (settingsStore.settings.promoteBeforeEndSeconds || 5) * 1000;
  if (remainingMs > thresholdMs) return;

  const next = queueStore.queue.find((r) => r.status === "pending");
  if (!next) {
    // Nothing to promote for this track — don't keep re-checking every tick
    // until the track actually changes.
    promotedForTrackId = playback.item.id;
    return;
  }

  // Flipped synchronously, before the await below — same reasoning as
  // commands/skip.js's promoteNextPending(): this is single-threaded JS, so
  // setting status here (not after addToQueue resolves) closes the window
  // where a mod's !skip, run while this call is in flight, could still find
  // this same entry "pending" and promote it a second time, double-queuing
  // the song in Spotify. Rolled back to "pending" on failure below.
  next.status = "sent";

  try {
    await spotify.addToQueue(next.trackUri);
    queueStore.save();
    console.log(`[SONGREQ] Promoted "${next.title}" (requested by ${next.requestedBy}) into Spotify's queue`);

    // This is the actual moment a channel-points request is fulfilled — not
    // when it was first accepted (see handlers/songRequestRedemption.js).
    // Keeping the redemption unfulfilled until now is what lets !remove
    // still trigger a real refund for a request that never got this far.
    if (next.rewardId && next.redemptionId) {
      try {
        await updateRedemptionStatus(next.rewardId, next.redemptionId, "FULFILLED");
      } catch (e) {
        console.error("[SONGREQ] Failed to mark redemption fulfilled:", e.response?.data || e.message);
      }
    }
  } catch (e) {
    next.status = "pending";
    console.error("[SONGREQ] Failed to promote pending request:", e.response?.data || e.message);
  } finally {
    promotedForTrackId = playback.item.id;
  }
}

module.exports = { tick };
