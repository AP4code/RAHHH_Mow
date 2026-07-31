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

// Direct lookup by track ID — used when the request is a Spotify link/URI
// rather than free text, so there's no search ambiguity to resolve at all.
async function getTrack(id) {
  const { data } = await spotifyApi({ method: "get", url: `${BASE}/tracks/${id}` });
  return data;
}

async function skip() {
  await spotifyApi({ method: "post", url: `${BASE}/me/player/next` });
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
  // Spotify's Feb 2026 API migration renamed this endpoint from
  // /playlists/{id}/tracks to /playlists/{id}/items (request body shape is
  // unchanged, still { uris: [...] }) — the old path was fully removed for
  // Development Mode apps as of March 9, 2026, returning 403 Forbidden.
  await spotifyApi({
    method: "post",
    url: `${BASE}/playlists/${playlistId}/items`,
    data: { uris: [uri] },
  });
}

// "Liked Songs" isn't a real playlist object — it has no playlist ID, so it
// can't go through addToPlaylist's /playlists/{id}/items endpoint. Saving
// to it is a completely separate Spotify endpoint that takes a bare track
// id (not a "spotify:track:..." uri) — see commands/add.js's LIKED_SONGS
// sentinel for where this gets picked over addToPlaylist.
async function saveTrack(id) {
  await spotifyApi({ method: "put", url: `${BASE}/me/tracks`, params: { ids: id } });
}

module.exports = {
  searchTrack,
  getTrack,
  getPlaybackState,
  addToQueue,
  getQueue,
  addToPlaylist,
  saveTrack,
  skip,
};
