const WebSocket = require("ws");
const { helix } = require("./auth");

/* ------------------------------------------------------------------ */
/* EventSub WebSocket — generic connection engine.                     */
/*                                                                     */
/* Twitch rule: a single websocket session may only carry              */
/* subscriptions created by ONE user's token, so the app wires up one  */
/* connection per token (see bot.js). This module only knows how to    */
/* run a connection; it has no idea what "chat" or "channel" mean.     */
/* ------------------------------------------------------------------ */

const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";

let shuttingDown = false;
const connections = [];

/**
 * @param {string} label - for logging
 * @param {object} tokenSet - from lib/auth.js
 * @param {() => Array<object>} subscriptions - lazily evaluated at connect time
 * @param {(type: string, event: object) => Promise<void>} onNotification
 */
function createEventSubConnection({ label, tokenSet, subscriptions, onNotification }) {
  const conn = {
    label,
    tokenSet,
    subscriptions,
    socket: null,
    sessionId: null,
    keepaliveTimer: null,
    keepaliveMs: 40000,
    reconnectAttempts: 0,
  };

  // Resolves once every initial subscription for this connection is confirmed;
  // rejects if any of them fail. Bootstrap waits on this before announcing
  // that the bot is listening, so a bad subscription blocks startup instead
  // of silently running in a half-connected state.
  let readyResolve, readyReject;
  conn.ready = new Promise((res, rej) => {
    readyResolve = res;
    readyReject = rej;
  });

  function armKeepalive() {
    clearTimeout(conn.keepaliveTimer);
    conn.keepaliveTimer = setTimeout(() => {
      console.warn(`[EVENTSUB:${label}] Keepalive missed — forcing reconnect`);
      try { conn.socket?.terminate(); } catch (_) {}
    }, conn.keepaliveMs);
  }

  async function createSubscription(sub) {
    try {
      await helix(conn.tokenSet, {
        method: "post",
        url: "https://api.twitch.tv/helix/eventsub/subscriptions",
        headers: { "Content-Type": "application/json" },
        data: {
          type: sub.type,
          version: sub.version,
          condition: sub.condition,
          transport: { method: "websocket", session_id: conn.sessionId },
        },
      });
      return true;
    } catch (e) {
      console.error(
        `[EVENTSUB:${label}] Failed to subscribe to ${sub.type}:`,
        e.response?.data || e.message
      );
      return false;
    }
  }

  async function createAllSubscriptions() {
    const subs = conn.subscriptions();
    let requiredFailed = 0;
    let optionalFailed = 0;

    for (const sub of subs) {
      if (!(await createSubscription(sub))) {
        if (sub.optional) optionalFailed++;
        else requiredFailed++;
      }
    }

    if (requiredFailed > 0) {
      readyReject(new Error(`${label}: ${requiredFailed}/${subs.length} required subscription(s) failed`));
      return;
    }

    if (optionalFailed > 0) {
      // Typically a scope the current token doesn't have yet (e.g. a
      // feature added after the token was issued) — logged above by
      // createSubscription already. Starting anyway means that feature is
      // just inactive until the token is reauthorized with the scope,
      // rather than bricking the whole bot over one missing permission.
      console.warn(`[EVENTSUB:${label}] ${optionalFailed} optional subscription(s) unavailable — continuing without them`);
    }

    const active = subs.length - requiredFailed - optionalFailed;
    console.log(`[EVENTSUB:${label}] ✓ ${active}/${subs.length} subscription(s) active`);
    readyResolve();
  }

  function connect(url = EVENTSUB_URL, isReconnect = false) {
    const oldSocket = isReconnect ? conn.socket : null;
    const ws = new WebSocket(url);

    ws.on("open", () => {
      if (isReconnect) console.log(`[EVENTSUB:${label}] Socket reconnected`);
    });

    ws.on("message", async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg.metadata?.message_type;

      switch (type) {
        case "session_welcome": {
          conn.socket = ws;
          conn.sessionId = msg.payload.session.id;
          conn.reconnectAttempts = 0;

          const kt = msg.payload.session.keepalive_timeout_seconds;
          if (kt) conn.keepaliveMs = (kt + 10) * 1000;
          armKeepalive();

          if (isReconnect) {
            console.log(`[EVENTSUB:${label}] Reconnected — session ${conn.sessionId}`);
            try { oldSocket?.close(); } catch (_) {}
          } else {
            await createAllSubscriptions();
          }
          break;
        }

        case "session_keepalive":
          armKeepalive();
          break;

        case "session_reconnect": {
          const newUrl = msg.payload.session.reconnect_url;
          console.log(`[EVENTSUB:${label}] Reconnect requested by Twitch`);
          connect(newUrl, true);
          break;
        }

        case "revocation": {
          const sub = msg.payload?.subscription;
          console.warn(`[EVENTSUB:${label}] Subscription revoked: ${sub?.type} (${sub?.status})`);
          break;
        }

        case "notification": {
          armKeepalive();
          try {
            await onNotification(msg.payload.subscription.type, msg.payload.event);
          } catch (e) {
            console.error(`[EVENTSUB:${label}] Handler error:`, e);
          }
          break;
        }
      }
    });

    ws.on("error", (e) => {
      console.error(`[EVENTSUB:${label}] Socket error:`, e.message);
    });

    ws.on("close", (code, reason) => {
      console.warn(`[EVENTSUB:${label}] Socket closed: ${code} ${reason?.toString() || ""}`);
      if (shuttingDown) return;
      if (ws !== conn.socket) return; // old socket closing after a reconnect

      clearTimeout(conn.keepaliveTimer);
      conn.sessionId = null;

      const delay = Math.min(30000, 1000 * Math.pow(2, conn.reconnectAttempts++));
      console.log(`[EVENTSUB:${label}] Reconnecting in ${delay}ms`);
      setTimeout(() => connect(), delay);
    });

    if (!isReconnect) conn.socket = ws;
    return ws;
  }

  conn.connect = connect;
  connections.push(conn);
  return conn;
}

function shutdown() {
  shuttingDown = true;
  for (const c of connections) {
    try { c.socket?.close(); } catch (_) {}
  }
}

module.exports = { createEventSubConnection, connections, shutdown };
