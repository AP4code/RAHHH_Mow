const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "../..");
const ENV_PATH = path.resolve(ROOT_DIR, "config/.env");

const DATA_DIR = path.resolve(ROOT_DIR, "data");
const SESSION_PATH = path.join(DATA_DIR, "session.json");
const ALLOWLIST_PATH = path.join(DATA_DIR, "allowlist.json");
const VIPLIST_PATH = path.join(DATA_DIR, "VIPList.json");
const SNACKS_PATH = path.join(DATA_DIR, "snacks.json");
const SONG_QUEUE_PATH = path.join(DATA_DIR, "songQueue.json");
const SONG_SETTINGS_PATH = path.join(DATA_DIR, "songRequestSettings.json");
const SONG_BLOCKLIST_PATH = path.join(DATA_DIR, "songBlocklist.json");
const NOW_PLAYING_PATH = path.join(DATA_DIR, "nowPlaying.json");
const CHECKIN_SETTINGS_PATH = path.join(DATA_DIR, "checkInSettings.json");
const WORDLE_WINS_PATH = path.join(DATA_DIR, "wordleWins.json");
const WORDLE_SETTINGS_PATH = path.join(DATA_DIR, "wordleSettings.json");

const SFX_DIR = path.resolve(ROOT_DIR, "sfx");

module.exports = {
  ROOT_DIR,
  ENV_PATH,
  DATA_DIR,
  SESSION_PATH,
  ALLOWLIST_PATH,
  VIPLIST_PATH,
  SNACKS_PATH,
  SONG_QUEUE_PATH,
  SONG_SETTINGS_PATH,
  SONG_BLOCKLIST_PATH,
  NOW_PLAYING_PATH,
  CHECKIN_SETTINGS_PATH,
  WORDLE_WINS_PATH,
  WORDLE_SETTINGS_PATH,
  SFX_DIR,
};
