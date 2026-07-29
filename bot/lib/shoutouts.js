const state = require("./state");
const { EXCEPTIONS_SET } = require("./env");
const { helix, streamerToken, getUserId } = require("./auth");
const { sendBotMessage } = require("./chat");
const sessionStore = require("./persistence/session");
const { allowlist, viplist } = require("./persistence/lists");
const overrides = require("./messageOverrides");

const CHANNEL_COOLDOWN_MS = 120 * 1000;
const MESSAGE_THRESHOLD = 3;
const VIP_SHOUTOUT_DELAY_MS = 5000;

const candidateQueue = new Set();
const vipPending = new Set();

// Shared by every shoutout trigger — manual (!so), auto (allowlist
// threshold/VIP), and raid — not just !so specifically.
const MESSAGES = {
  announce: {
    default: " missmeowMeowSmokyYay Go check out our homie {login}, they last played {game} missmeowMeowSmokyWow ",
    description: "Sent after every official shoutout (manual !so, automatic, or raid).",
    placeholders: ["login", "game"],
  },
};

overrides.registerDefaults("shoutout", MESSAGES);

async function sendOfficialShoutout(login, reason = "auto") {
  const lower = login.toLowerCase();

  if (EXCEPTIONS_SET.has(lower)) {
    console.log(`[SHOUTOUT] Skipping ${lower} — in exceptions list`);
    return;
  }

  const userId = await getUserId(lower, streamerToken);
  if (!userId) {
    console.warn(`[SHOUTOUT] Could not resolve user ID for ${lower}`);
    return;
  }

  console.log(`[SHOUTOUT] Sending ${reason} shoutout to ${lower}`);

  try {
    await helix(streamerToken, {
      method: "post",
      url: "https://api.twitch.tv/helix/chat/shoutouts",
      params: {
        from_broadcaster_id: state.broadcasterId,
        to_broadcaster_id: userId,
        moderator_id: state.broadcasterId, // shoutouts are sent as the streamer themselves
      },
    });

    console.log(`[SHOUTOUT] ✓ ${lower} shouted out (${reason})`);

    // Fires for every trigger — manual (!so), auto (allowlist threshold/VIP),
    // and raid — so a mod using !so gets the same "go check out our homie"
    // follow-up as an automatic shoutout would, not just the bare Twitch
    // shoutout card.
    try {
      const { data } = await helix(streamerToken, {
        method: "get",
        url: "https://api.twitch.tv/helix/channels",
        params: { broadcaster_id: userId },
      });

      const game = data?.data?.[0]?.game_name || "something cool recently";
      console.log(`[SHOUTOUT] ${lower} last played: ${game}`);

      await sendBotMessage(
        overrides.getMessage("shoutout", "announce", MESSAGES.announce.default, { login: lower, game })
      );
    } catch (e) {
      const status = e.response?.status;
      console.error(`[SHOUTOUT] ✗ Failed to shoutout ${lower} (${reason}):`, e.response?.data ?? e.message);

      if (status === 429) {
        console.log(`[SHOUTOUT] Cooldown hit — marking ${lower} as handled to prevent retry spam`);
        sessionStore.sessionShouted.add(lower);
      }
    }

    sessionStore.sessionShouted.add(lower);
    sessionStore.session.lastChannelShoutoutAt = Date.now();

    if (allowlist.has(lower)) {
      sessionStore.session.lastShoutout = lower;
      sessionStore.save();
    }
  } catch (e) {
    console.error(`[SHOUTOUT] ✗ Failed to shoutout ${lower} (${reason}):`, e.response?.data ?? e.message);
  }
}

async function processCandidates() {
  if (!candidateQueue.size) return;

  for (const login of Array.from(candidateQueue)) {
    candidateQueue.delete(login);

    if (!allowlist.has(login)) continue;
    if (sessionStore.sessionShouted.has(login)) continue;

    if (Date.now() - sessionStore.session.lastChannelShoutoutAt < CHANNEL_COOLDOWN_MS) {
      console.log(`[SHOUTOUT] Channel cooldown active — re-queuing ${login}`);
      candidateQueue.add(login);
      continue;
    }

    await sendOfficialShoutout(login, "auto");
  }
}

function maybeQueueVipShoutout(login) {
  if (!viplist.has(login) || sessionStore.sessionShouted.has(login) || vipPending.has(login)) return;

  console.log(`[SHOUTOUT] VIP detected: ${login} — queuing shoutout`);
  vipPending.add(login);

  setTimeout(async () => {
    vipPending.delete(login);

    if (sessionStore.sessionShouted.has(login)) return;
    if (Date.now() - sessionStore.session.lastChannelShoutoutAt < CHANNEL_COOLDOWN_MS) {
      console.log(`[SHOUTOUT] Channel cooldown active — skipping VIP shoutout for ${login}`);
      return;
    }

    await sendOfficialShoutout(login, "auto");
  }, VIP_SHOUTOUT_DELAY_MS);
}

function registerChatActivity(login) {
  const count = (sessionStore.messageCounts.get(login) || 0) + 1;
  sessionStore.messageCounts.set(login, count);
  sessionStore.save();

  if (allowlist.has(login) && count >= MESSAGE_THRESHOLD && !sessionStore.sessionShouted.has(login)) {
    console.log(`[SHOUTOUT] ${login} hit message threshold (${count}/${MESSAGE_THRESHOLD}) — adding to candidate queue`);
    candidateQueue.add(login);
  }
}

module.exports = {
  sendOfficialShoutout,
  processCandidates,
  maybeQueueVipShoutout,
  registerChatActivity,
};
