const axios = require("axios");
const { updateEnvFile } = require("./auth");

/* ------------------------------------------------------------------ */
/* Spotify OAuth token — a single account, mirroring lib/auth.js's      */
/* Twitch token-set pattern. Client id/secret + access/refresh tokens   */
/* are all written to .env by the Tauri spotify_login command on first  */
/* connect (see src-tauri/src/main.rs); this module only ever refreshes */
/* what's already there.                                               */
/* ------------------------------------------------------------------ */

const tokenSet = {
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  accessToken: process.env.SPOTIFY_ACCESS_TOKEN,
  refreshToken: process.env.SPOTIFY_REFRESH_TOKEN,
  _refreshInFlight: null,
};

function isConfigured() {
  return Boolean(tokenSet.clientId && tokenSet.clientSecret && tokenSet.refreshToken);
}

async function refresh() {
  if (!isConfigured()) return null;
  if (tokenSet._refreshInFlight) return tokenSet._refreshInFlight;

  tokenSet._refreshInFlight = (async () => {
    try {
      const { data } = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokenSet.refreshToken,
        }),
        {
          headers: {
            Authorization:
              "Basic " + Buffer.from(`${tokenSet.clientId}:${tokenSet.clientSecret}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      tokenSet.accessToken = data.access_token;
      // Spotify doesn't always rotate the refresh token — only persist it when it does.
      if (data.refresh_token) tokenSet.refreshToken = data.refresh_token;

      updateEnvFile({
        SPOTIFY_ACCESS_TOKEN: tokenSet.accessToken,
        SPOTIFY_REFRESH_TOKEN: tokenSet.refreshToken,
      });

      console.log("[SPOTIFY] Token refreshed successfully");
      return tokenSet.accessToken;
    } catch (err) {
      console.error("[SPOTIFY] Refresh failed:", err.response?.data || err.message);
      throw err;
    } finally {
      tokenSet._refreshInFlight = null;
    }
  })();

  return tokenSet._refreshInFlight;
}

/**
 * Authenticated Spotify Web API call. Refreshes + retries once on 401,
 * mirroring lib/auth.js's helix() wrapper.
 */
async function spotifyApi(config, retry = true) {
  if (!isConfigured()) throw new Error("Spotify is not connected");

  try {
    return await axios({
      ...config,
      headers: { Authorization: `Bearer ${tokenSet.accessToken}`, ...(config.headers || {}) },
    });
  } catch (e) {
    if (e.response?.status === 401 && retry) {
      console.warn("[SPOTIFY] 401 — refreshing token and retrying");
      await refresh();
      return spotifyApi(config, false);
    }
    throw e;
  }
}

module.exports = { tokenSet, isConfigured, refresh, spotifyApi };
