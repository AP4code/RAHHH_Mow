const state = require("../state");
const { TARGET_CHANNEL_LOGIN } = require("../env");
const { sendChat, sendBotMessage } = require("../chat");
const sessionStore = require("../persistence/session");
const overrides = require("../messageOverrides");

/* ------------------------------------------------------------------ */
/* Coin toss mini-game — periodically challenges a recently-active     */
/* chatter to call heads or tails for points. Ported from the old      */
/* tmi.js-based bot (bot_with_coin_toss.js); logic is unchanged aside  */
/* from adapting to Helix sends and a couple of small hardening tweaks */
/* noted inline.                                                       */
/* ------------------------------------------------------------------ */

const COIN_USER_COOLDOWN_MS = 30 * 60 * 1000; // how long a winner/loser sits out before being eligible again
const COIN_EVENT_INTERVAL_MS = 10 * 60 * 1000; // how often we try to start a new challenge
const COIN_RESPONSE_WINDOW_MS = 30 * 1000; // time the challenged user has to answer
const COIN_REVEAL_DELAY_MS = 2000; // suspense before revealing the flip
const RECENT_CHAT_WINDOW_MS = 15 * 1000; // must have chatted this recently to be eligible
const COIN_WIN_POINTS = 500;

const EXCLUDED_LOGINS = new Set(["streamelements"]);

const recentChatters = new Map(); // login -> last message timestamp
const recentCoinUsers = new Map(); // login -> cooldown expiry timestamp

let enabled = true;
let activeUser = null;
let responseTimeout = null;

const MESSAGES = {
  challenge: {
    default: "@{login} HEADS or TAILS? 👀 Type !coin heads or !coin tails",
    description: "Sent when a chatter is challenged to a coin toss.",
    placeholders: ["login"],
  },
  timeout: {
    default: "@{login} took too long missmeowSmokyJudge ",
    description: "Sent if the challenged chatter doesn't answer in time.",
    placeholders: ["login"],
  },
  invalidChoice: {
    default: "@{login} choose heads or tails!",
    description: "Sent when the challenged chatter replies with anything other than heads/tails.",
    placeholders: ["login"],
  },
  flipping: {
    default: "🪙 Flipping the coin...",
    description: "Sent right after a valid heads/tails choice, before the result.",
    placeholders: [],
  },
  win: {
    default: " missmeowMeowSmokyYay It landed on {result}!! @{login} wins {points} points!",
    description: "Sent when the coin lands on the chatter's choice.",
    placeholders: ["result", "login", "points"],
  },
  lose: {
    default: "It landed on {result}... unlucky @{login} missmeowMiyazakiHehehe ",
    description: "Sent when the coin doesn't land on the chatter's choice.",
    placeholders: ["result", "login"],
  },
};

overrides.registerDefaults("coin", MESSAGES);

function isExcluded(login) {
  return (
    login === TARGET_CHANNEL_LOGIN.toLowerCase() ||
    login === state.botLogin ||
    login === state.modLogin ||
    EXCLUDED_LOGINS.has(login)
  );
}

/** Called for every chat message that didn't match a command — marks the user as recently active. */
function trackActivity(login) {
  recentChatters.set(login, Date.now());
}

function isEnabled() {
  return enabled;
}

function cancelActiveChallenge() {
  clearTimeout(responseTimeout);
  responseTimeout = null;
  activeUser = null;
}

function setEnabled(value) {
  enabled = value;
  if (!enabled) cancelActiveChallenge();
}

function pickEligibleUser() {
  const now = Date.now();
  const eligible = [];

  for (const [login, lastSeen] of recentChatters) {
    if (now - lastSeen > RECENT_CHAT_WINDOW_MS) {
      recentChatters.delete(login); // stale — prune while we're already iterating (avoids unbounded growth)
      continue;
    }
    if (isExcluded(login)) continue;

    const cooldownUntil = recentCoinUsers.get(login);
    if (cooldownUntil) {
      if (cooldownUntil <= now) recentCoinUsers.delete(login); // expired — reclaim it
      else continue;
    }

    eligible.push(login);
  }

  if (!eligible.length) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

async function startEvent() {
  if (!enabled || activeUser) return;
  if (sessionStore.session.live === false) return; // no chat to challenge if the stream's down

  const login = pickEligibleUser();
  if (!login) {
    console.log("[COIN] No eligible users");
    return;
  }

  activeUser = login;
  await sendBotMessage(overrides.getMessage("coin", "challenge", MESSAGES.challenge.default, { login }));
  console.log(`[COIN] Started for ${login}`);

  responseTimeout = setTimeout(async () => {
    if (activeUser === login) {
      await sendBotMessage(overrides.getMessage("coin", "timeout", MESSAGES.timeout.default, { login }));
      cancelActiveChallenge();
    }
  }, COIN_RESPONSE_WINDOW_MS);
}

async function handleChoice(login, rawChoice) {
  if (!activeUser || login !== activeUser) return;

  const choice = (rawChoice || "").toLowerCase();
  if (choice !== "heads" && choice !== "tails") {
    await sendBotMessage(overrides.getMessage("coin", "invalidChoice", MESSAGES.invalidChoice.default, { login }));
    return;
  }

  clearTimeout(responseTimeout);
  responseTimeout = null;

  const result = Math.random() < 0.5 ? "heads" : "tails";
  await sendBotMessage(overrides.getMessage("coin", "flipping", MESSAGES.flipping.default, {}));

  setTimeout(async () => {
    if (choice === result) {
      await sendBotMessage(
        overrides.getMessage("coin", "win", MESSAGES.win.default, {
          result: result.toUpperCase(),
          login,
          points: COIN_WIN_POINTS,
        })
      );
      // Talks directly to the points/loyalty bot in chat — bypass sendBotMessage
      // so this doesn't get echoed back by !repeat.
      setTimeout(() => sendChat(`!givepoints ${login} ${COIN_WIN_POINTS}`), 1000);
    } else {
      await sendBotMessage(
        overrides.getMessage("coin", "lose", MESSAGES.lose.default, { result: result.toUpperCase(), login })
      );
    }

    recentCoinUsers.set(login, Date.now() + COIN_USER_COOLDOWN_MS);
    activeUser = null;
  }, COIN_REVEAL_DELAY_MS);
}

function start() {
  setInterval(startEvent, COIN_EVENT_INTERVAL_MS);
}

module.exports = { trackActivity, isEnabled, setEnabled, handleChoice, start };
