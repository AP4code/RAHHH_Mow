const fs = require("fs");
const axios = require("axios");
const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = require("./env");
const { ENV_PATH } = require("./paths");

/* ------------------------------------------------------------------ */
/* auth — three independent token sets                                 */
/*   bot:      cheesybot   -> reads/sends chat only                    */
/*   streamer: broadcaster -> shoutouts + general lookups              */
/*   mod:      smoothcheese01 -> clips only                            */
/* ------------------------------------------------------------------ */

function makeTokenSet(label, accessEnvKey, refreshEnvKey) {
  return {
    label,
    accessToken: process.env[accessEnvKey],
    refreshToken: process.env[refreshEnvKey],
    accessEnvKey,
    refreshEnvKey,
    _refreshInFlight: null,
  };
}

const botToken = makeTokenSet("bot", "BOT_USER_ACCESS_TOKEN", "BOT_REFRESH_TOKEN");
const streamerToken = makeTokenSet("streamer", "STREAMER_USER_ACCESS_TOKEN", "STREAMER_REFRESH_TOKEN");
const modToken = makeTokenSet("mod", "MOD_USER_ACCESS_TOKEN", "MOD_REFRESH_TOKEN");

function authHeaders(token) {
  return { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` };
}

function updateEnvFile(updates) {
  let env = fs.readFileSync(ENV_PATH, "utf8");

  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(env)) {
      env = env.replace(re, `${key}=${value}`);
    } else {
      env += `${env.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
    }
  }

  fs.writeFileSync(ENV_PATH, env);
}

async function refreshTokenSet(ts) {
  if (ts._refreshInFlight) return ts._refreshInFlight;

  ts._refreshInFlight = (async () => {
    try {
      const { data } = await axios.post(
        "https://id.twitch.tv/oauth2/token",
        null,
        {
          params: {
            grant_type: "refresh_token",
            refresh_token: ts.refreshToken,
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
          },
        }
      );

      ts.accessToken = data.access_token;
      if (data.refresh_token) ts.refreshToken = data.refresh_token;

      updateEnvFile({
        [ts.accessEnvKey]: ts.accessToken,
        [ts.refreshEnvKey]: ts.refreshToken,
      });

      console.log(`[TWITCH] (${ts.label}) token refreshed successfully`);
      return ts.accessToken;
    } catch (err) {
      console.error(`[TWITCH] (${ts.label}) refresh failed:`, err.response?.data || err.message);
      throw err;
    } finally {
      ts._refreshInFlight = null;
    }
  })();

  return ts._refreshInFlight;
}

/**
 * Helix call scoped to a specific token set. Refreshes + retries once on 401.
 */
async function helix(ts, config, retry = true) {
  try {
    return await axios({
      ...config,
      headers: { ...authHeaders(ts.accessToken), ...(config.headers || {}) },
    });
  } catch (e) {
    if (e.response?.status === 401 && retry) {
      console.warn(`[HELIX] (${ts.label}) 401 — refreshing token and retrying`);
      await refreshTokenSet(ts);
      return helix(ts, config, false);
    }
    throw e;
  }
}

async function getSelfUser(ts) {
  const { data } = await helix(ts, {
    method: "get",
    url: "https://api.twitch.tv/helix/users",
  });
  return data.data?.[0] || null;
}

const loginToId = new Map();

function cacheUserId(login, id) {
  loginToId.set(login.toLowerCase(), id);
}

/** General-purpose login->id lookup. Defaults to the streamer token ("everything else"). */
async function getUserId(login, ts = streamerToken) {
  if (loginToId.has(login)) return loginToId.get(login);

  const { data } = await helix(ts, {
    method: "get",
    url: "https://api.twitch.tv/helix/users",
    params: { login },
  });

  const id = data.data?.[0]?.id || null;
  if (id) loginToId.set(login, id);
  return id;
}

async function isChannelLive(bId, ts = streamerToken) {
  try {
    const { data } = await helix(ts, {
      method: "get",
      url: "https://api.twitch.tv/helix/streams",
      params: { user_id: bId, first: 1 },
    });
    return data.data && data.data.length > 0;
  } catch (e) {
    console.error("[LIVE CHECK]", e.response?.data || e.message);
    return false;
  }
}

async function refreshAll() {
  for (const ts of [botToken, streamerToken, modToken]) {
    try {
      await refreshTokenSet(ts);
    } catch (err) {
      console.error(`[TWITCH] (${ts.label}) refresh failed`);
    }
  }
}

module.exports = {
  botToken,
  streamerToken,
  modToken,
  helix,
  refreshTokenSet,
  refreshAll,
  getSelfUser,
  getUserId,
  cacheUserId,
  isChannelLive,
  updateEnvFile,
};
