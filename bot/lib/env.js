require("dotenv").config({ path: require("./paths").ENV_PATH });

const moment = require("moment-timezone");

const {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TARGET_CHANNEL_LOGIN,
  EXCEPTIONS = "",
  TIME_TIMEZONE = "Asia/Almaty",
  SFX_SERVER_PORT = "8420",
} = process.env;

// Validate once at startup rather than on every !time call — an invalid
// IANA name throws a RangeError from Intl, so fall back to UTC instead of
// silently dropping the command's response.
// Validated (and later used for the actual !time calculation, see
// commands/time.js) via moment-timezone rather than the runtime's native
// Intl/ICU — the bundled Node executable's built-in tzdata is frozen at
// whatever it shipped with and goes stale (e.g. it still thinks Asia/Almaty
// is UTC+6, a full hour off since Kazakhstan's March 2024 reform to UTC+5).
// moment-timezone ships its own tzdata that gets refreshed via `npm update`,
// independent of the bundled Node binary's age.
let RESOLVED_TIMEZONE = "UTC";
if (moment.tz.zone(TIME_TIMEZONE)) {
  RESOLVED_TIMEZONE = TIME_TIMEZONE;
} else {
  console.warn(`[TIME] Invalid TIME_TIMEZONE "${TIME_TIMEZONE}" — falling back to UTC`);
}

if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || !TARGET_CHANNEL_LOGIN) {
  console.error("Missing required env: TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TARGET_CHANNEL_LOGIN");
  process.exit(1);
}

if (!process.env.BOT_REFRESH_TOKEN || !process.env.STREAMER_REFRESH_TOKEN || !process.env.MOD_REFRESH_TOKEN) {
  console.error(
    "Missing one or more refresh tokens: BOT_REFRESH_TOKEN, STREAMER_REFRESH_TOKEN, MOD_REFRESH_TOKEN"
  );
  process.exit(1);
}

const EXCEPTIONS_SET = new Set(
  EXCEPTIONS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
);

module.exports = {
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TARGET_CHANNEL_LOGIN,
  EXCEPTIONS_SET,
  RESOLVED_TIMEZONE,
  SFX_SERVER_PORT: Number(SFX_SERVER_PORT) || 8420,
};
