const path = require("path");
const fs = require("fs");
const axios = require("axios");

require("dotenv").config({
  path: path.resolve(__dirname, "../config/.env"),
});

const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URI } = process.env;

const ENV_KEYS = {
  bot: { access: "BOT_USER_ACCESS_TOKEN", refresh: "BOT_REFRESH_TOKEN" },
  streamer: { access: "STREAMER_USER_ACCESS_TOKEN", refresh: "STREAMER_REFRESH_TOKEN" },
  mod: { access: "MOD_USER_ACCESS_TOKEN", refresh: "MOD_REFRESH_TOKEN" },
};

function usageAndExit() {
  console.error("Usage: node exchange-token.js <bot|streamer|mod> <code> [redirect_uri]");
  console.error("  redirect_uri defaults to $TWITCH_REDIRECT_URI if set.");
  process.exit(1);
}

function updateEnvFile(updates) {
  const envPath = path.resolve(__dirname, "../config/.env");
  let env = fs.readFileSync(envPath, "utf8");

  for (const [key, value] of Object.entries(updates)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    if (re.test(env)) {
      env = env.replace(re, `${key}=${value}`);
    } else {
      env += `${env.endsWith("\n") ? "" : "\n"}${key}=${value}\n`;
    }
  }

  fs.writeFileSync(envPath, env);
}

async function main() {
  const [, , label, code, redirectUriArg] = process.argv;

  if (!label || !ENV_KEYS[label] || !code) usageAndExit();

  const redirectUri = redirectUriArg || TWITCH_REDIRECT_URI;
  if (!redirectUri) {
    console.error("No redirect_uri given and TWITCH_REDIRECT_URI is not set in .env.");
    usageAndExit();
  }

  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.error("TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET missing from .env.");
    process.exit(1);
  }

  console.log(`Exchanging code for "${label}" tokens…`);

  let tokenData;
  try {
    const { data } = await axios.post("https://id.twitch.tv/oauth2/token", null, {
      params: {
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      },
    });
    tokenData = data;
  } catch (e) {
    console.error("Token exchange failed:", e.response?.data || e.message);
    console.error(
      "Common causes: code already used (codes are single-use), code expired " +
      "(they're short-lived), or redirect_uri doesn't exactly match the one used to get the code."
    );
    process.exit(1);
  }

  const { access_token, refresh_token, scope, expires_in } = tokenData;

  if (!refresh_token) {
    console.warn(
      "No refresh_token returned — make sure your authorize URL included a scope " +
      "(app-only/no-scope tokens don't get refresh tokens)."
    );
  }

  // Confirm which account this actually is, so a mis-click doesn't silently
  // write cheesybot's token into the streamer slot or vice versa.
  try {
    const { data: validated } = await axios.get("https://id.twitch.tv/oauth2/validate", {
      headers: { Authorization: `OAuth ${access_token}` },
    });
    console.log(`Token belongs to: ${validated.login} (user_id ${validated.user_id})`);
    console.log(`Scopes granted:  ${(validated.scopes || []).join(", ") || "(none)"}`);
  } catch (e) {
    console.warn("Could not validate the new token:", e.response?.data || e.message);
  }

  console.log(`Expires in: ${expires_in}s (~${Math.round(expires_in / 3600)}h)`);
  if (scope) console.log(`Requested scope string: ${Array.isArray(scope) ? scope.join(" ") : scope}`);

  const keys = ENV_KEYS[label];
  updateEnvFile({
    [keys.access]: access_token,
    [keys.refresh]: refresh_token || "",
  });

  console.log(`✓ Wrote ${keys.access} and ${keys.refresh} to config/.env`);
}

main();
