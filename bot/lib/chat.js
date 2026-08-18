const state = require("./state");
const { botToken, streamerToken, modToken, helix } = require("./auth");

/* ------------------------------------------------------------------ */
/* sending chat — bot account by default (sendChat/sendBotMessage), the  */
/* streamer's own account (sendStreamerChat, used by the Daily Check-In  */
/* redemption so the confirmation reads as coming from the broadcaster,  */
/* not the bot), or the mod account (sendModChat). sendAs() picks one of */
/* the three by string, for commands/redeems whose sender is a saved     */
/* per-item setting rather than hardcoded at the call site.              */
/* ------------------------------------------------------------------ */

const MAX_CHAT_LEN = 500;

// Twitch rate-limits chat sends per account, so each sender gets its own
// queue/backoff state — a streamer-sent message shouldn't have to wait
// behind whatever the bot is currently sending, or vice versa.
const SEND_INTERVAL_MS = 1200;
const sendQueues = new Map(); // label -> { chain: Promise, lastSentAt: number }

let lastBotMessage = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getQueue(label) {
  if (!sendQueues.has(label)) sendQueues.set(label, { chain: Promise.resolve(), lastSentAt: 0 });
  return sendQueues.get(label);
}

function enqueueSend(label, fn) {
  const q = getQueue(label);

  q.chain = q.chain
    .then(async () => {
      const wait = SEND_INTERVAL_MS - (Date.now() - q.lastSentAt);
      if (wait > 0) await sleep(wait);
      try {
        await fn();
      } finally {
        q.lastSentAt = Date.now();
      }
    })
    .catch((e) => {
      console.error(`[CHAT] Queue error (${label}):`, e.message);
    });

  return q.chain;
}

function splitMessage(text) {
  const out = [];
  let rest = String(text);

  while (rest.length > MAX_CHAT_LEN) {
    let cut = rest.lastIndexOf(" ", MAX_CHAT_LEN);
    if (cut <= 0) cut = MAX_CHAT_LEN;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function postChatMessage(tokenSet, body, attempt = 0) {
  try {
    const { data } = await helix(tokenSet, {
      method: "post",
      url: "https://api.twitch.tv/helix/chat/messages",
      headers: { "Content-Type": "application/json" },
      data: body,
    });

    const result = data.data?.[0];
    if (result && result.is_sent === false) {
      console.warn(
        `[CHAT] Message dropped by Twitch: ${result.drop_reason?.code} — ${result.drop_reason?.message}`
      );
    }
  } catch (e) {
    if (e.response?.status === 429 && attempt < 3) {
      const backoff = 2000 * (attempt + 1);
      console.warn(`[CHAT] Rate limited — retrying in ${backoff}ms`);
      await sleep(backoff);
      return postChatMessage(tokenSet, body, attempt + 1);
    }
    console.error("[CHAT] Send failed:", e.response?.data || e.message);
  }
}

/**
 * Send a chat message via Helix, always as the bot account.
 * replyTo: optional message_id to reply to (EventSub gives you these for free).
 */
async function sendChat(text, replyTo = null) {
  for (const chunk of splitMessage(text)) {
    const body = {
      broadcaster_id: state.broadcasterId,
      sender_id: state.botUserId,
      message: chunk,
    };
    if (replyTo) body.reply_parent_message_id = replyTo;

    await enqueueSend("bot", () => postChatMessage(botToken, body));
    replyTo = null; // only the first chunk is a reply
  }
}

function sendBotMessage(text, replyTo = null) {
  lastBotMessage = text;
  return sendChat(text, replyTo);
}

/**
 * Same shape as sendChat, but sent as the streamer's own account —
 * requires user:write:chat on the streamer token.
 */
async function sendStreamerChat(text, replyTo = null) {
  for (const chunk of splitMessage(text)) {
    const body = {
      broadcaster_id: state.broadcasterId,
      sender_id: state.broadcasterId,
      message: chunk,
    };
    if (replyTo) body.reply_parent_message_id = replyTo;

    await enqueueSend("streamer", () => postChatMessage(streamerToken, body));
    replyTo = null;
  }
}

/**
 * Same shape as sendChat, but sent as the mod account — requires
 * user:write:chat on the mod token (added alongside clips:edit; a mod
 * token connected before this scope was added will 401/403 until
 * reconnected via the Settings "Connect Mod Account" button).
 */
async function sendModChat(text, replyTo = null) {
  for (const chunk of splitMessage(text)) {
    const body = {
      broadcaster_id: state.broadcasterId,
      sender_id: state.modUserId,
      message: chunk,
    };
    if (replyTo) body.reply_parent_message_id = replyTo;

    await enqueueSend("mod", () => postChatMessage(modToken, body));
    replyTo = null;
  }
}

function getLastBotMessage() {
  return lastBotMessage;
}

// Dispatches to the right sender by the "sendAs" value saved on a command
// or redeem ("bot" | "streamer" | "mod") — falls back to the bot account
// for anything else, which covers both the default and commands/redeems
// saved before this setting existed (no sendAs field at all).
function sendAs(account, text, replyTo = null) {
  if (account === "streamer") return sendStreamerChat(text, replyTo);
  if (account === "mod") return sendModChat(text, replyTo);
  return sendBotMessage(text, replyTo);
}

module.exports = { sendChat, sendBotMessage, sendStreamerChat, sendModChat, sendAs, getLastBotMessage, splitMessage };
