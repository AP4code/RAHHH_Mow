const spotify = require("./spotify");
const queueStore = require("./persistence/songQueue");

/* ------------------------------------------------------------------ */
/* Shared by commands/queue.js and commands/next.js — merges this app's */
/* own pending song requests (listed first, since they're what           */
/* lib/songQueueScheduler.js promotes into Spotify's real queue next)    */
/* with whatever's already in Spotify's own device queue after that.     */
/* Already-promoted ("sent") requests are deliberately excluded from the */
/* pending half since they're already reflected in Spotify's live queue  */
/* itself — including them again here would duplicate them.              */
/* ------------------------------------------------------------------ */

async function getUpcoming() {
  const pending = queueStore.queue
    .filter((r) => r.status === "pending")
    .map((r) => ({ title: r.title, artist: r.artist, requestedBy: r.requestedBy }));

  let spotifyQueue = [];
  try {
    const data = await spotify.getQueue();
    spotifyQueue = (data?.queue || []).map((t) => ({
      title: t.name,
      artist: (t.artists || []).map((a) => a.name).join(", "),
      requestedBy: null,
    }));
  } catch (e) {
    console.error("[SONGREQ] Queue lookup failed:", e.response?.data || e.message);
  }

  return [...pending, ...spotifyQueue];
}

module.exports = { getUpcoming };
