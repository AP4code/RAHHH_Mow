const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../config/.env") });

const axios = require("axios");
const WebSocket = require("ws");

/* ------------------------------------------------------------------ */
/* Standalone CLI sub counter — lives outside bot/ on purpose, fully   */
/* separate process from the main Twitch bot. Only shares config/.env */
/* for credentials. Counts from whenever this script starts, not from */
/* stream start (Twitch's EventSub has no "subs so far" backfill).    */
/* ------------------------------------------------------------------ */

const ENV_PATH = path.resolve(__dirname, "../config/.env");
const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
const TIER_LABELS = { "1000": "Tier 1", "2000": "Tier 2", "3000": "Tier 3" };

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  STREAMER_USER_ACCESS_TOKEN,
  STREAMER_REFRESH_TOKEN,
  BOT_USER_ACCESS_TOKEN,
  BOT_REFRESH_TOKEN,
  TARGET_CHANNEL_LOGIN,
} = process.env;

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !STREAMER_REFRESH_TOKEN || !BOT_REFRESH_TOKEN) {
  console.error("Missing TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET / STREAMER_REFRESH_TOKEN / BOT_REFRESH_TOKEN in config/.env");
  process.exit(1);
}

function makeTokenSet(label, accessToken, refreshToken, accessEnvKey, refreshEnvKey) {
  return { label, accessToken, refreshToken, accessEnvKey, refreshEnvKey };
}

// streamer token: creates the EventSub subscriptions (needs channel:read:subscriptions)
// bot token: posts the milestone message to chat (needs user:write:chat)
const streamerToken = makeTokenSet("streamer", STREAMER_USER_ACCESS_TOKEN, STREAMER_REFRESH_TOKEN, "STREAMER_USER_ACCESS_TOKEN", "STREAMER_REFRESH_TOKEN");
const botToken = makeTokenSet("bot", BOT_USER_ACCESS_TOKEN, BOT_REFRESH_TOKEN, "BOT_USER_ACCESS_TOKEN", "BOT_REFRESH_TOKEN");

// Twitch's EventSub has no backfill — it only streams events from the
// moment this socket connects, so subs that already happened earlier in
// the stream have to be seeded manually: `node sub-counter.js 11`.
const seed = parseInt(process.argv[2], 10);
let subCount = Number.isFinite(seed) ? seed : 0;
let broadcasterId = null;
let botUserId = null;
let socket = null;
let sessionId = null;
let keepaliveTimer = null;
let keepaliveMs = 40000;
let reconnectAttempts = 0;
let shuttingDown = false;

function tierLabel(tier) {
  return TIER_LABELS[tier] || tier || "";
}

function timestamp() {
  return new Date().toLocaleTimeString();
}

function updateEnvFile(updates) {
  let env = fs.readFileSync(ENV_PATH, "utf8");
  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    env = re.test(env) ? env.replace(re, `${key}=${value}`) : env + `${env.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_PATH, env);
}

async function refreshTokenSet(ts) {
  const { data } = await axios.post("https://id.twitch.tv/oauth2/token", null, {
    params: {
      grant_type: "refresh_token",
      refresh_token: ts.refreshToken,
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
    },
  });
  ts.accessToken = data.access_token;
  if (data.refresh_token) ts.refreshToken = data.refresh_token;
  // Keep config/.env in sync — the main bot reads the same file, and Twitch
  // may rotate the refresh token on use, invalidating the old one on disk.
  updateEnvFile({ [ts.accessEnvKey]: ts.accessToken, [ts.refreshEnvKey]: ts.refreshToken });
}

async function helix(ts, config, retry = true) {
  try {
    return await axios({
      ...config,
      headers: { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${ts.accessToken}`, ...(config.headers || {}) },
    });
  } catch (e) {
    if (e.response?.status === 401 && retry) {
      console.warn(`[${timestamp()}] (${ts.label}) Access token expired — refreshing...`);
      await refreshTokenSet(ts);
      return helix(ts, config, false);
    }
    throw e;
  }
}

function armKeepalive() {
  clearTimeout(keepaliveTimer);
  keepaliveTimer = setTimeout(() => {
    console.warn(`[${timestamp()}] Keepalive missed — forcing reconnect`);
    try { socket?.terminate(); } catch (_) {}
  }, keepaliveMs);
}

async function createSubscription(type, condition) {
  try {
    await helix(streamerToken, {
      method: "post",
      url: "https://api.twitch.tv/helix/eventsub/subscriptions",
      headers: { "Content-Type": "application/json" },
      data: { type, version: "1", condition, transport: { method: "websocket", session_id: sessionId } },
    });
    return true;
  } catch (e) {
    console.error(`[${timestamp()}] Failed to subscribe to ${type}:`, e.response?.data || e.message);
    return false;
  }
}

// Posts as the bot account — requires user:write:chat on the bot token.
async function sendChat(text) {
  try {
    await helix(botToken, {
      method: "post",
      url: "https://api.twitch.tv/helix/chat/messages",
      headers: { "Content-Type": "application/json" },
      data: { broadcaster_id: broadcasterId, sender_id: botUserId, message: text },
    });
  } catch (e) {
    console.error(`[${timestamp()}] Chat post failed:`, e.response?.data || e.message);
  }
}

const MILESTONE_STEP = 5;

function handleNotification(type, event) {
  if (type === "channel.subscribe") {
    // Fires for every new sub, including each individual gift recipient —
    // channel.subscription.gift below is announcement-only and NOT added
    // to the count, or gifted subs would be counted twice.
    subCount++;
    const tag = event.is_gift ? " (gift)" : "";
    console.log(
      `[${timestamp()}] \x1b[32m+1\x1b[0m ${event.user_name} subscribed${tag} — ${tierLabel(event.tier)}  ` +
      `\x1b[1mTotal this stream: ${subCount}\x1b[0m`
    );
    if (subCount % MILESTONE_STEP === 0) {
      const banner = `${subCount} SUBS THIS STREAM!`;
      const border = "*".repeat(banner.length + 4);
      console.log(`\x1b[33m\x1b[1m${border}\n* ${banner} *\n${border}\x1b[0m`);
      sendChat(`🎉 ${banner} 🎉`);
    }
  } else if (type === "channel.subscription.gift") {
    const gifter = event.is_anonymous ? "An anonymous gifter" : event.user_name;
    console.log(
      `[${timestamp()}] \x1b[36m🎁\x1b[0m ${gifter} gifted ${event.total} sub(s) — ${tierLabel(event.tier)}`
    );
  }
}

function connect(url = EVENTSUB_URL, isReconnect = false) {
  const oldSocket = isReconnect ? socket : null;
  const ws = new WebSocket(url);

  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.metadata?.message_type) {
      case "session_welcome": {
        socket = ws;
        sessionId = msg.payload.session.id;
        reconnectAttempts = 0;

        const kt = msg.payload.session.keepalive_timeout_seconds;
        if (kt) keepaliveMs = (kt + 10) * 1000;
        armKeepalive();

        if (isReconnect) {
          console.log(`[${timestamp()}] Reconnected — session ${sessionId}`);
          try { oldSocket?.close(); } catch (_) {}
        } else {
          const okSub = await createSubscription("channel.subscribe", { broadcaster_user_id: broadcasterId });
          const okGift = await createSubscription("channel.subscription.gift", { broadcaster_user_id: broadcasterId });
          if (!okSub) {
            console.error("Could not subscribe to channel.subscribe — check the streamer token has channel:read:subscriptions. Exiting.");
            process.exit(1);
          }
          if (!okGift) console.warn("channel.subscription.gift subscription failed — gift announcements will be silent, but individual gift recipients will still be counted.");
          console.log(`\nListening for subs on #${TARGET_CHANNEL_LOGIN} — counting from now.\n`);
        }
        break;
      }

      case "session_keepalive":
        armKeepalive();
        break;

      case "session_reconnect":
        console.log(`[${timestamp()}] Reconnect requested by Twitch`);
        connect(msg.payload.session.reconnect_url, true);
        break;

      case "revocation": {
        const sub = msg.payload?.subscription;
        console.warn(`[${timestamp()}] Subscription revoked: ${sub?.type} (${sub?.status})`);
        break;
      }

      case "notification":
        armKeepalive();
        handleNotification(msg.payload.subscription.type, msg.payload.event);
        break;
    }
  });

  ws.on("error", (e) => console.error(`[${timestamp()}] Socket error:`, e.message));

  ws.on("close", (code, reason) => {
    if (shuttingDown) return;
    if (ws !== socket) return; // old socket closing after a reconnect

    clearTimeout(keepaliveTimer);
    sessionId = null;

    const delay = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts++));
    console.warn(`[${timestamp()}] Socket closed (${code}) — reconnecting in ${delay}ms`);
    setTimeout(() => connect(), delay);
  });

  if (!isReconnect) socket = ws;
  return ws;
}

process.on("SIGINT", () => {
  shuttingDown = true;
  try { socket?.close(); } catch (_) {}
  console.log(`\nFinal count — ${subCount} sub(s) this stream.`);
  process.exit(0);
});

(async () => {
  await Promise.all([streamerToken, botToken].map((ts) =>
    refreshTokenSet(ts).catch((e) => {
      console.error(`Initial ${ts.label} token refresh failed:`, e.response?.data || e.message);
      process.exit(1);
    })
  ));

  const [streamerRes, botRes] = await Promise.all([
    helix(streamerToken, { method: "get", url: "https://api.twitch.tv/helix/users" }),
    helix(botToken, { method: "get", url: "https://api.twitch.tv/helix/users" }),
  ]);
  const me = streamerRes.data.data?.[0];
  const botSelf = botRes.data.data?.[0];
  if (!me || !botSelf) {
    console.error("Could not resolve streamer/bot identity — check tokens in config/.env");
    process.exit(1);
  }
  broadcasterId = me.id;
  botUserId = botSelf.id;
  console.log(`Sub counter for #${me.login} — starting count at ${subCount}${subCount ? " (seeded)" : ""}. Milestones post to chat as ${botSelf.login}.`);
  connect();
})();
