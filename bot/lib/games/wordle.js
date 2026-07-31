const { sendBotMessage } = require("../chat");
const overrides = require("../messageOverrides");
const winsStore = require("../persistence/wordleWins");
const settingsStore = require("../persistence/wordleSettings");
const ANSWERS = require("./wordleAnswers");
const GUESSES = require("./wordleWords");

/* ------------------------------------------------------------------ */
/* Wordle chat game — ported from the standalone WordleChatV5 exe/tmi.js */
/* client that missmeowzaki used to start and stop by hand between       */
/* streams. Two levels of control, same as the original:                 */
/*   1. active/inactive — the whole game, toggled with !sw               */
/*      (commands/startWordle.js). Guess-checking only runs while active. */
/*   2. paused/resumed — freezes the CURRENT round's timer without        */
/*      discarding progress (commands/wordlePause.js /                  */
/*      commands/wordlePlay.js), independent of the on/off toggle.       */
/* Overlay state pushes go through lib/sfxServer.js's SSE routes, same    */
/* one-directional push mechanism already used for the SFX/Now Playing    */
/* overlays — see pushWordleEvent/pushWordleState there.                 */
/* ------------------------------------------------------------------ */

const VALID_GUESSES = new Set(GUESSES);
const LENGTH_HINT_COOLDOWN_MS = 12_000;

let active = false;
let paused = false;
let roundActive = false;
let secretWord = null;
let remainingTime = 0;
let roundStartTime = null;
let guessedWords = new Set();
let deadLetters = new Set();
// Every guess made this round, replayed to a freshly-connected/reconnected
// overlay (e.g. after an OBS scene switch) so it isn't stuck showing a
// blank board for a round that's already in progress.
let currentRoundGuesses = [];

let roundTimer = null;
let autoRestartTimer = null;
let lastLengthHintAt = 0;

const MESSAGES = {
  started: {
    default: "🟣 Wordle game is now active! Type any 5-letter word to guess. missmeowMeowSmokyYay ",
    description: "Sent when !sw activates the Wordle game.",
    placeholders: [],
  },
  stopped: {
    default: "Wordle game has ended. Thanks for playing! missmeowMiyazakiHehehe ",
    description: "Sent when !sw deactivates the Wordle game.",
    placeholders: [],
  },
  paused: {
    default: "⏸ Wordle paused by {login}.",
    description: "Sent when a mod pauses the round with !pause.",
    placeholders: ["login"],
  },
  resumed: {
    default: "▶ Wordle resumed by {login}.",
    description: "Sent when a mod resumes the round with !play/!resume.",
    placeholders: ["login"],
  },
  resetByMod: {
    default: "🔄 Wordle round reset by {login}.",
    description: "Sent when a mod force-resets the round with !reset/!restart.",
    placeholders: ["login"],
  },
  timeout: {
    default: "⏱ Time's up! The secret word was: {word} — try again! missmeowMiyazakiHehehe ",
    description: "Sent when a round's timer runs out with nobody guessing correctly.",
    placeholders: ["word"],
  },
  win: {
    default: "🧩 @{login} found the hidden word! missmeowMeowSmokyYay The word was: {word} | Total wins: {wins} missmeowMeowSmokyWow ",
    description: "Sent when someone guesses the secret word correctly.",
    placeholders: ["login", "word", "wins"],
  },
  topWinsNone: {
    default: "WORDLE LEADERBOARD: No wins yet! missmeowSmokyDerp ",
    description: "Sent by !topwins when nobody's won yet.",
    placeholders: [],
  },
  topWins: {
    default: " missmeowMeowSmokyYay WORDLE LEADERBOARD: {list}",
    description: "Sent by !topwins with the top 5 win counts.",
    placeholders: ["list"],
  },
  help: {
    default:
      "🟣 WORDLE HELP: Type any real 5-letter word in chat to guess. Green = right letter, right spot. Yellow = right letter, wrong spot. Grey = not in the word. Unlimited guesses until time runs out. Mods: !pause / !play / !reset | Leaderboard: !topwins",
    description: "Sent by !help.",
    placeholders: [],
  },
  lengthHint: {
    default: "Only 5-letter words are allowed in Wordle Chat missmeowSmokyJudge ",
    description: "Sent (rate-limited) when someone types a 6-7 letter word while a round is active.",
    placeholders: [],
  },
};

// Registered per owning command (matching each command file's own catalog
// key) rather than one shared "wordle" key, so each command's card on the
// Commands page gets its own "Edit messages" button. Game-lifecycle events
// that aren't triggered by a specific typed command (timeout/win/lengthHint)
// are grouped under startWordle, since !sw is what turns the game on in the
// first place.
overrides.registerDefaults("startWordle", {
  started: MESSAGES.started,
  stopped: MESSAGES.stopped,
  timeout: MESSAGES.timeout,
  win: MESSAGES.win,
  lengthHint: MESSAGES.lengthHint,
});
overrides.registerDefaults("wordlePause", { paused: MESSAGES.paused });
overrides.registerDefaults("wordlePlay", { resumed: MESSAGES.resumed });
overrides.registerDefaults("wordleReset", { resetByMod: MESSAGES.resetByMod });
overrides.registerDefaults("wordleTopWins", {
  topWinsNone: MESSAGES.topWinsNone,
  topWins: MESSAGES.topWins,
});
overrides.registerDefaults("wordleHelp", { help: MESSAGES.help });

// Lazy require — sfxServer never needs to know about wordle.js, this just
// dodges having to care about which of the two modules bot.js requires
// first.
function pushEvent(data) {
  require("../sfxServer").pushWordleEvent(data);
}

function isActive() {
  return active;
}

function isPaused() {
  return paused;
}

function pickRandomWord() {
  return ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
}

function evaluateGuess(guess, secret) {
  const result = Array(5).fill("dead");
  const secretLetters = secret.split("");

  for (let i = 0; i < 5; i++) {
    if (guess[i] === secret[i]) {
      result[i] = "green";
      secretLetters[i] = null;
    }
  }
  for (let i = 0; i < 5; i++) {
    if (result[i] === "green") continue;
    const idx = secretLetters.indexOf(guess[i]);
    if (idx !== -1) {
      result[i] = "yellow";
      secretLetters[idx] = null;
    }
  }
  return result;
}

function getRemainingMs() {
  if (!roundActive) return 0;
  if (paused || !roundStartTime) return remainingTime;
  return Math.max(0, remainingTime - (Date.now() - roundStartTime));
}

// Full board snapshot — pushed to a freshly-connected overlay client (see
// lib/sfxServer.js's /wordle-events route) so switching OBS scenes mid-round
// doesn't show a blank board.
function getSnapshot() {
  return {
    type: "state",
    active,
    paused,
    roundActive,
    guesses: currentRoundGuesses,
    deadLetters: [...deadLetters],
    remainingMs: getRemainingMs(),
    durationMs: (settingsStore.settings.roundDurationSeconds || 105) * 1000,
  };
}

function pushState() {
  require("../sfxServer").pushWordleState(getSnapshot());
}

function startTimer() {
  clearTimeout(roundTimer);
  roundStartTime = Date.now();
  roundTimer = setTimeout(onTimeout, remainingTime);
}

async function onTimeout() {
  roundActive = false;
  pushEvent({ type: "timeout", word: secretWord });
  await sendBotMessage(
    overrides.getMessage("startWordle", "timeout", MESSAGES.timeout.default, { word: secretWord })
  );
  scheduleAutoRestart();
  console.log("[WORDLE] Time up");
}

function scheduleAutoRestart() {
  if (!active || paused) return;
  clearTimeout(autoRestartTimer);
  const delay = (settingsStore.settings.autoRestartDelaySeconds || 10) * 1000;
  autoRestartTimer = setTimeout(() => {
    if (!active || paused) return;
    startRound("system");
  }, delay);
}

function startRound(by = "system") {
  clearTimeout(autoRestartTimer);
  clearTimeout(roundTimer);

  secretWord = pickRandomWord();
  remainingTime = (settingsStore.settings.roundDurationSeconds || 105) * 1000;
  roundActive = true;
  guessedWords.clear();
  deadLetters.clear();
  currentRoundGuesses = [];

  pushEvent({ type: "reset", by, durationMs: remainingTime });
  startTimer();
  console.log("[WORDLE] New round started");
}

// !sw — the top-level on/off toggle. Returns which state it ended up in, so
// the command can send the right confirmation.
async function toggle() {
  if (active) {
    active = false;
    paused = false;
    roundActive = false;
    clearTimeout(roundTimer);
    clearTimeout(autoRestartTimer);
    secretWord = null;
    currentRoundGuesses = [];
    deadLetters.clear();
    pushState();
    await sendBotMessage(overrides.getMessage("startWordle", "stopped", MESSAGES.stopped.default));
    console.log("[WORDLE] Deactivated");
    return "stopped";
  }

  active = true;
  paused = false;
  await sendBotMessage(overrides.getMessage("startWordle", "started", MESSAGES.started.default));
  startRound("system");
  console.log("[WORDLE] Activated");
  return "started";
}

// !pause — freezes the current round's timer without discarding it.
async function pause(login) {
  if (!active || paused) return;
  paused = true;
  if (roundStartTime) {
    remainingTime = Math.max(0, remainingTime - (Date.now() - roundStartTime));
    roundStartTime = null;
  }
  clearTimeout(roundTimer);
  clearTimeout(autoRestartTimer);
  pushEvent({ type: "pause", value: true, remainingTime, by: login });
  await sendBotMessage(overrides.getMessage("wordlePause", "paused", MESSAGES.paused.default, { login }));
  console.log(`[WORDLE] Paused by ${login}`);
}

// !play / !resume
async function resume(login) {
  if (!active || !paused) return;
  paused = false;
  pushEvent({ type: "pause", value: false, remainingTime, by: login });
  if (roundActive && remainingTime > 0) startTimer();
  await sendBotMessage(overrides.getMessage("wordlePlay", "resumed", MESSAGES.resumed.default, { login }));
  console.log(`[WORDLE] Resumed by ${login}`);
}

// !reset / !restart
async function resetRound(login) {
  if (!active) return;
  paused = false;
  startRound(login);
  await sendBotMessage(overrides.getMessage("wordleReset", "resetByMod", MESSAGES.resetByMod.default, { login }));
  console.log(`[WORDLE] Reset by ${login}`);
}

function getTopWins(limit = 5) {
  return Object.entries(winsStore.wins)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
}

async function sendTopWins() {
  const top = getTopWins(5);
  if (!top.length) {
    await sendBotMessage(overrides.getMessage("wordleTopWins", "topWinsNone", MESSAGES.topWinsNone.default));
    return;
  }
  const list = top.map(([name, count], i) => `${i + 1}) @${name}: ${count}`).join(" | ");
  await sendBotMessage(overrides.getMessage("wordleTopWins", "topWins", MESSAGES.topWins.default, { list }));
}

async function sendHelp() {
  await sendBotMessage(overrides.getMessage("wordleHelp", "help", MESSAGES.help.default));
}

// Called from handlers/chatMessage.js's passive tail for every message that
// didn't match a command — mirrors shoutouts.registerChatActivity /
// cointoss.trackActivity's placement, but gated on `active` first since
// unlike those two, this only means anything while a round's actually on.
async function handleGuess(login, rawMessage) {
  if (!active) return;

  const msg = (rawMessage || "").trim().toLowerCase();

  if (!paused && roundActive && /^[a-z]{6,7}$/.test(msg)) {
    const now = Date.now();
    if (now - lastLengthHintAt > LENGTH_HINT_COOLDOWN_MS) {
      lastLengthHintAt = now;
      await sendBotMessage(overrides.getMessage("startWordle", "lengthHint", MESSAGES.lengthHint.default));
    }
    return;
  }

  if (paused || !roundActive) return;
  if (!/^[a-z]{5}$/.test(msg)) return;

  const guess = msg.toUpperCase();
  if (!VALID_GUESSES.has(guess)) return;
  if (guessedWords.has(guess)) return;
  guessedWords.add(guess);

  const result = evaluateGuess(guess, secretWord);
  currentRoundGuesses.push({ user: login, word: guess, result });
  result.forEach((r, i) => {
    if (r === "dead") deadLetters.add(guess[i]);
  });

  pushEvent({ type: "guess", user: login, word: guess, result });

  if (guess === secretWord) {
    roundActive = false;
    clearTimeout(roundTimer);

    const total = (winsStore.wins[login] || 0) + 1;
    winsStore.wins[login] = total;
    winsStore.save();

    pushEvent({ type: "win", user: login, word: secretWord, wins: total });
    await sendBotMessage(
      overrides.getMessage("startWordle", "win", MESSAGES.win.default, { login, word: secretWord, wins: total })
    );

    scheduleAutoRestart();
    console.log(`[WORDLE] ${login} won | total wins ${total}`);
  }
}

module.exports = {
  isActive,
  isPaused,
  toggle,
  pause,
  resume,
  resetRound,
  handleGuess,
  getTopWins,
  sendTopWins,
  sendHelp,
  getSnapshot,
};
