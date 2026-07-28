const { spotifyApi } = require("./spotifyAuth");

/* ------------------------------------------------------------------ */
/* Thin wrapper around the Spotify Web API — no SDK, matching how this  */
/* app already calls Twitch Helix directly via axios.                  */
/* ------------------------------------------------------------------ */

const BASE = "https://api.spotify.com/v1";

async function searchTrack(query) {
  const { data } = await spotifyApi({
    method: "get",
    url: `${BASE}/search`,
    params: { q: query, type: "track", limit: 1 },
  });
  return data.tracks?.items?.[0] || null;
}

/**
 * Returns the full playback object, or null when nothing is active
 * (Spotify replies 204 No Content in that case — not an error).
 */
async function getPlaybackState() {
  const res = await spotifyApi({ method: "get", url: `${BASE}/me/player` });
  if (res.status === 204 || !res.data) return null;
  return res.data;
}

async function addToQueue(uri) {
  await spotifyApi({ method: "post", url: `${BASE}/me/player/queue`, params: { uri } });
}

/**
 * Returns { currently_playing, queue: [...] } — Spotify's own device queue,
 * which already reflects anything this app has promoted into it via
 * addToQueue above.
 */
async function getQueue() {
  const { data } = await spotifyApi({ method: "get", url: `${BASE}/me/player/queue` });
  return data;
}

async function addToPlaylist(playlistId, uri) {
  if (!playlistId) return;
  await spotifyApi({
    method: "post",
    url: `${BASE}/playlists/${playlistId}/tracks`,
    data: { uris: [uri] },
  });
}

module.exports = { searchTrack, getPlaybackState, addToQueue, getQueue, addToPlaylist };
