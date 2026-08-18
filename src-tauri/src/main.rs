#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager, WindowEvent};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_dialog::DialogExt;
use std::fs;
use serde_json::Value;
use std::collections::HashMap;

static TRAY_NOTICE_SHOWN: AtomicBool = AtomicBool::new(false);

struct BotState {
    process: Mutex<Option<Child>>,
}

/// Returns the root project directory.
/// - In dev:  cwd is `src-tauri/`, root is one level up.
/// - In prod: resource dir contains the bundled bot/, data/, config/ folders.
fn get_root(app: &tauri::AppHandle) -> PathBuf {
    #[cfg(not(debug_assertions))]
    {
        // current_exe() gives a clean path without the \\?\ prefix that
        // resource_dir() adds on Windows, which breaks Node.js module loading.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                return dir.to_path_buf();
            }
        }
        // Fallback: strip \\?\ prefix if present
        if let Ok(res) = app.path().resource_dir() {
            let s = res.to_string_lossy();
            return if s.starts_with(r"\\?\") {
                PathBuf::from(&s[4..])
            } else {
                res
            };
        }
    }

    // Dev: walk up from cwd until we find bot/bot.js
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for ancestor in cwd.ancestors() {
        if ancestor.join("bot").join("bot.js").exists() {
            return ancestor.to_path_buf();
        }
    }
    cwd
}

// Reads a single KEY=value out of config/.env without building the whole
// file into a map — for callers (like start_bot) that need one value and
// aren't the (async, #[tauri::command]-only) load_env.
fn read_env_value(root: &PathBuf, key: &str) -> Option<String> {
    let env_path = root.join("config").join(".env");
    let content = fs::read_to_string(&env_path).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == key {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

#[tauri::command]
fn start_bot(app: tauri::AppHandle, state: tauri::State<BotState>) -> Result<(), String> {
    let mut lock = state.process.lock().unwrap();

    if lock.is_some() {
        return Err("Bot already running".into());
    }

    let root = get_root(&app);
    let bot_dir  = root.join("bot");
    let bot_file = bot_dir.join("bot.js");

    println!("Starting bot: {:?}", bot_file);

    let node_path = root.join("node").join("node.exe");

    if !node_path.exists() {
    return Err(format!("Node executable not found at {:?}", node_path));
    }

    // bot.js's own SFX/Now Playing/Wordle server binds this port, but it
    // swallows a bind failure into its own log stream rather than crashing
    // the process — so a stale process left over from a prior run that
    // didn't shut down cleanly (crash, force-kill, update overwrite) can
    // silently squat on the port forever, and every symptom shows up three
    // layers away (no sound, no overlay) with nothing pointing back at the
    // real cause. Catching it here, before the child even spawns, turns
    // that into one clear, immediate error instead of a fresh investigation
    // each time.
    let sfx_port = read_env_value(&root, "SFX_SERVER_PORT")
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(8420);

    if std::net::TcpListener::bind(("127.0.0.1", sfx_port)).is_err() {
        return Err(format!(
            "Port {} is already in use by another process — likely a leftover bot instance from a previous run that didn't shut down cleanly. Close it in Task Manager (look for a stray node.exe) or restart your PC, then try again.",
            sfx_port
        ));
    }

    let mut child = Command::new(node_path)
    .arg("--no-warnings")
    .arg(bot_file)
    .current_dir(&bot_dir)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .creation_flags(0x08000000) // ← hides terminal window
    .spawn()
    .map_err(|e| format!("Failed to spawn node: {}", e))?;

    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let app_stdout = app.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            if let Ok(line) = line {
                app_stdout.emit("bot-log", line.clone()).ok();
                if line.contains("Listening in") {
                    app_stdout.emit("bot-ready", true).ok();
                }
            }
        }

        // stdout closing means the process has exited, whether from a crash
        // or a manual stop_bot() kill — clear the stored handle so a future
        // start_bot isn't blocked by a dead Child, and tell the frontend so a
        // "Starting..." button that never saw "bot-ready" can recover instead
        // of staying stuck forever.
        if let Some(state) = app_stdout.try_state::<BotState>() {
            *state.process.lock().unwrap() = None;
        }
        app_stdout.emit("bot-exited", true).ok();
    });

    let app_stderr = app.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            if let Ok(line) = line {
                app_stderr.emit("bot-log", format!("ERR: {}", line)).ok();
            }
        }
    });

    *lock = Some(child);
    Ok(())
}

#[tauri::command]
fn stop_bot(state: tauri::State<BotState>) -> Result<(), String> {
    let mut lock = state.process.lock().unwrap();
    if let Some(child) = lock.as_mut() {
        child.kill().map_err(|e| e.to_string())?;
    }
    *lock = None;
    Ok(())
}

#[tauri::command]
fn load_list(app: tauri::AppHandle, name: String) -> Result<Value, String> {
    let path = get_root(&app).join("data").join(format!("{}.json", name));
    let data = fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {:?}: {}", path, e))?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_list(app: tauri::AppHandle, name: String, content: Value) -> Result<(), String> {
    let path = get_root(&app).join("data").join(format!("{}.json", name));
    // Same reasoning as write_env_updates above — data/*.json is gitignored
    // (per-installation state), so a fresh clone has no data/ folder until
    // something creates it. The bot process does this itself once it's run
    // at least once, but this command can be called from the UI before that.
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(&content).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Cannot write {:?}: {}", path, e))
}

#[tauri::command]
fn load_env(app: tauri::AppHandle) -> Result<HashMap<String, String>, String> {
    let path = get_root(&app).join("config").join(".env");
    let content = fs::read_to_string(&path)
        .map_err(|e| format!("Cannot read {:?}: {}", path, e))?;

    let mut map = HashMap::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    Ok(map)
}

// Rewrites matching KEY=value lines in place and leaves everything else
// (comments, blank lines, key order) untouched, rather than rebuilding the
// whole file from a HashMap — that used to silently drop any comments and
// reshuffle key order on every save. Shared by the save_env command and
// spotify_login (which persists tokens the same way after a successful
// OAuth exchange).
fn write_env_updates(env_path: &PathBuf, updates: &HashMap<String, String>) -> Result<(), String> {
    // config/.env is gitignored (it holds live secrets) and it's the only
    // file in that directory, so a fresh clone/install has no config/
    // folder at all until something creates it — without this, the very
    // first save on a new install would fail with "no such file or
    // directory" before the app ever wrote its first .env line.
    if let Some(parent) = env_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    let existing = fs::read_to_string(env_path).unwrap_or_default();
    let mut seen_keys: std::collections::HashSet<&str> = std::collections::HashSet::new();

    let mut out_lines: Vec<String> = Vec::new();
    for line in existing.lines() {
        let trimmed = line.trim();
        let replacement = (!trimmed.is_empty() && !trimmed.starts_with('#'))
            .then(|| trimmed.split_once('='))
            .flatten()
            .and_then(|(k, _)| updates.get(k.trim()).map(|v| (k.trim(), v)));

        if let Some((key, value)) = replacement {
            out_lines.push(format!("{}={}", key, value));
            seen_keys.insert(key);
        } else {
            out_lines.push(line.to_string());
        }
    }

    // Anything that wasn't already a key in the file is new — append it
    for (k, v) in updates {
        if !seen_keys.contains(k.as_str()) {
            out_lines.push(format!("{}={}", k, v));
        }
    }

    let mut content = out_lines.join("\n");
    content.push('\n');

    fs::write(env_path, content)
        .map_err(|e| format!("Cannot write {:?}: {}", env_path, e))
}

#[tauri::command]
fn save_env(app: tauri::AppHandle, env: HashMap<String, String>) -> Result<(), String> {
    let path = get_root(&app).join("config").join(".env");
    write_env_updates(&path, &env)
}

#[derive(serde::Serialize)]
struct BotStats {
    running: bool,
    channel: String,
    allowlist: usize,
    viplist: usize,
    #[serde(rename = "lastShoutout")]
    last_shoutout: Option<String>,
    live: bool,
}

#[tauri::command]
fn get_bot_stats(app: tauri::AppHandle, state: tauri::State<BotState>) -> BotStats {
    let root = get_root(&app);
    let running = state.process.lock().unwrap().is_some();

    let allowlist = fs::read_to_string(root.join("data").join("allowlist.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["users"].as_array().map(|a| a.len()))
        .unwrap_or(0);

    let viplist = fs::read_to_string(root.join("data").join("VIPList.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["users"].as_array().map(|a| a.len()))
        .unwrap_or(0);

    let (last_shoutout, live) = fs::read_to_string(root.join("data").join("session.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| (
            v["lastShoutout"].as_str().map(|s| s.to_string()),
            v["live"].as_bool().unwrap_or(false),
        ))
        .unwrap_or((None, false));

    // Read channel from .env rather than relying on env vars
    let channel = load_env(app)
        .ok()
        .and_then(|m| m.get("TARGET_CHANNEL_LOGIN").cloned())
        .unwrap_or_default();

    BotStats { running, channel, allowlist, viplist, last_shoutout, live }
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener().open_url(&url, None::<&str>).map_err(|e| e.to_string())
}

// Fixed local port for the Spotify OAuth callback — shown read-only in the
// Song Requests settings so the user can paste it into their Spotify
// Developer app's Redirect URI field, same BYO-app-credentials convention
// this app already uses for Twitch.
const SPOTIFY_CALLBACK_PORT: u16 = 17845;

fn random_state() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

// Parses the request line of the single GET the browser sends to the local
// callback listener, e.g. "GET /callback?code=...&state=... HTTP/1.1". Shared
// by every OAuth flow in this file (Spotify, Twitch) — the redirect shape is
// identical regardless of provider.
fn parse_oauth_callback(request_line: &str, expected_state: &str) -> Result<String, String> {
    let path_and_query = request_line
        .split_whitespace()
        .nth(1)
        .ok_or("Malformed callback request")?;
    let query = path_and_query.splitn(2, '?').nth(1).unwrap_or("");

    let mut code = None;
    let mut state = None;
    let mut error = None;

    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next().unwrap_or("");
        let v = percent_decode(it.next().unwrap_or(""));
        match k {
            "code" => code = Some(v),
            "state" => state = Some(v),
            "error" => error = Some(v),
            _ => {}
        }
    }

    if let Some(e) = error {
        return Err(format!("Authorization denied: {}", e));
    }
    let code = code.ok_or("No authorization code in callback")?;
    if state.unwrap_or_default() != expected_state {
        return Err("State mismatch — possible CSRF, please try connecting again".into());
    }
    Ok(code)
}

// How long an OAuth Connect button waits for the browser round-trip before
// giving up.
const OAUTH_CALLBACK_TIMEOUT_SECS: u64 = 120;

// std::net::TcpListener::accept() has no built-in timeout, and a plain OS
// thread blocked inside it can't be cancelled by an async timeout on the
// caller's side — so if the user closes the browser tab instead of
// finishing the flow, the thread (and the port it's bound to) would leak
// forever, permanently blocking any retry until the whole app restarts.
// Polling in non-blocking mode against a deadline lets the thread actually
// give up and drop the listener, freeing the port.
fn accept_with_timeout(
    listener: &std::net::TcpListener,
    timeout: std::time::Duration,
) -> std::io::Result<std::net::TcpStream> {
    listener.set_nonblocking(true)?;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                stream.set_nonblocking(false)?;
                return Ok(stream);
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "timed out waiting for the browser redirect",
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Full Spotify Authorization Code flow: opens the system browser for the
/// user to approve access, catches the redirect on a short-lived local
/// listener, exchanges the code for tokens, and persists everything to
/// config/.env via the same line-preserving writer save_env uses. Standard
/// Authorization Code + client secret (not PKCE) since this app already
/// stores BYO Twitch app secrets the same way — there's no shared client ID
/// to protect here, unlike apps that ship one client ID to every user.
#[tauri::command]
async fn spotify_login(app: tauri::AppHandle, client_id: String, client_secret: String) -> Result<(), String> {
    let redirect_uri = format!("http://127.0.0.1:{}/callback", SPOTIFY_CALLBACK_PORT);
    let state_token = random_state();
    let scopes = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-modify-public playlist-modify-private playlist-read-private playlist-read-collaborative user-library-modify";

    let auth_url = format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&state={}",
        percent_encode(&client_id),
        percent_encode(scopes),
        percent_encode(&redirect_uri),
        percent_encode(&state_token)
    );

    let listener = std::net::TcpListener::bind(("127.0.0.1", SPOTIFY_CALLBACK_PORT))
        .map_err(|e| format!("Failed to start the local callback listener on port {}: {}", SPOTIFY_CALLBACK_PORT, e))?;

    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let expected_state = state_token.clone();
    std::thread::spawn(move || {
        use std::io::{Read, Write};
        match accept_with_timeout(&listener, std::time::Duration::from_secs(OAUTH_CALLBACK_TIMEOUT_SECS)) {
            Ok(mut stream) => {
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let first_line = request.lines().next().unwrap_or("");
                let result = parse_oauth_callback(first_line, &expected_state);

                let body = if result.is_ok() {
                    "<html><body><h2>Spotify connected.</h2><p>You can close this window and return to rahhh.</p></body></html>"
                } else {
                    "<html><body><h2>Spotify connection failed.</h2><p>You can close this window and try again in rahhh.</p></body></html>"
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = tx.send(result);
            }
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                let _ = tx.send(Err("Timed out waiting for Spotify sign-in — please try connecting again.".into()));
            }
            Err(e) => {
                let _ = tx.send(Err(format!("Callback listener error: {}", e)));
            }
        }
    });

    let code = match rx.await {
        Ok(Ok(code)) => code,
        Ok(Err(e)) => {
            app.emit("spotify-connect-error", e.clone()).ok();
            return Err(e);
        }
        Err(_) => {
            let e = "Callback listener closed unexpectedly".to_string();
            app.emit("spotify-connect-error", e.clone()).ok();
            return Err(e);
        }
    };

    let http = reqwest::Client::new();
    let token_result = http
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e));

    let resp = match token_result {
        Ok(r) => r,
        Err(e) => {
            app.emit("spotify-connect-error", e.clone()).ok();
            return Err(e);
        }
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            let e = format!("Token exchange response parse failed: {}", e);
            app.emit("spotify-connect-error", e.clone()).ok();
            return Err(e);
        }
    };

    let access_token = match json["access_token"].as_str() {
        Some(t) => t.to_string(),
        None => {
            let e = format!("Spotify did not return an access token: {}", json);
            app.emit("spotify-connect-error", e.clone()).ok();
            return Err(e);
        }
    };
    let refresh_token = match json["refresh_token"].as_str() {
        Some(t) => t.to_string(),
        None => {
            let e = "Spotify did not return a refresh token — try disconnecting the app in your Spotify account settings and reconnecting.".to_string();
            app.emit("spotify-connect-error", e.clone()).ok();
            return Err(e);
        }
    };

    let mut updates = HashMap::new();
    updates.insert("SPOTIFY_CLIENT_ID".to_string(), client_id);
    updates.insert("SPOTIFY_CLIENT_SECRET".to_string(), client_secret);
    updates.insert("SPOTIFY_ACCESS_TOKEN".to_string(), access_token);
    updates.insert("SPOTIFY_REFRESH_TOKEN".to_string(), refresh_token);
    updates.insert("SPOTIFY_REDIRECT_URI".to_string(), redirect_uri);

    let env_path = get_root(&app).join("config").join(".env");
    if let Err(e) = write_env_updates(&env_path, &updates) {
        app.emit("spotify-connect-error", e.clone()).ok();
        return Err(e);
    }

    app.emit("spotify-connected", true).ok();
    Ok(())
}

// Different fixed port than Spotify's (17845) — registered once in the
// user's Twitch app, reused by all three Connect buttons (bot/streamer/mod)
// since they all share one Twitch app's client ID/secret.
const TWITCH_CALLBACK_PORT: u16 = 17846;

/// Same shape as spotify_login, generalized for Twitch's three separate
/// accounts (bot/streamer/mod): reads TWITCH_CLIENT_ID/SECRET (already in
/// .env, used by the bot process itself) rather than taking them as
/// arguments, runs the Authorization Code flow with force_verify=true so the
/// user can pick a *different* Twitch login each time instead of silently
/// reusing whatever account their browser is already signed into, resolves
/// which account actually got connected via /helix/users so the UI can show
/// it, and writes the resulting tokens under whichever env keys the caller
/// asks for (BOT_/STREAMER_/MOD_ prefixed). Returns the connected login on
/// success.
#[tauri::command]
async fn twitch_login(
    app: tauri::AppHandle,
    scopes: String,
    access_key: String,
    refresh_key: String,
) -> Result<String, String> {
    let env_path = get_root(&app).join("config").join(".env");
    let env_content = fs::read_to_string(&env_path).unwrap_or_default();

    let mut client_id = String::new();
    let mut client_secret = String::new();
    for line in env_content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "TWITCH_CLIENT_ID" => client_id = v.trim().to_string(),
                "TWITCH_CLIENT_SECRET" => client_secret = v.trim().to_string(),
                _ => {}
            }
        }
    }

    if client_id.is_empty() || client_secret.is_empty() {
        return Err("Set your Twitch Client ID and Client Secret in Settings first.".into());
    }

    // "localhost" (rather than a literal loopback IP) because that's what
    // Twitch's own docs use as their canonical redirect URI example — unlike
    // Spotify, which actually rejects a plain "localhost" redirect URI and
    // requires 127.0.0.1 (see spotify_login above). Since "localhost" can
    // resolve to either the IPv4 (127.0.0.1) or IPv6 (::1) loopback
    // depending on the OS's resolver preference, the listener below binds
    // both and accepts whichever one the browser actually connects to,
    // rather than gambling on one and silently hanging if the browser picks
    // the other.
    let redirect_uri = format!("http://localhost:{}/callback", TWITCH_CALLBACK_PORT);
    let state_token = random_state();

    let auth_url = format!(
        "https://id.twitch.tv/oauth2/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&state={}&force_verify=true",
        percent_encode(&client_id),
        percent_encode(&scopes),
        percent_encode(&redirect_uri),
        percent_encode(&state_token)
    );

    let mut listeners = vec![
        std::net::TcpListener::bind(("127.0.0.1", TWITCH_CALLBACK_PORT)).map_err(|e| {
            format!("Failed to start the local callback listener on 127.0.0.1:{}: {}", TWITCH_CALLBACK_PORT, e)
        })?,
    ];
    // IPv6 loopback is best-effort — not every machine has it enabled, and
    // the IPv4 listener above is enough to make the flow work either way.
    if let Ok(l6) = std::net::TcpListener::bind(("::1", TWITCH_CALLBACK_PORT)) {
        listeners.push(l6);
    }

    app.opener()
        .open_url(&auth_url, None::<&str>)
        .map_err(|e| e.to_string())?;

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let expected_state = state_token.clone();
    for listener in listeners {
        let tx = tx.clone();
        let expected_state = expected_state.clone();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            // Whichever listener (v4 or v6) actually gets the browser's
            // request wins the race; if neither does within the timeout,
            // both threads give up and release their port on their own —
            // see accept_with_timeout's doc comment for why that matters.
            match accept_with_timeout(&listener, std::time::Duration::from_secs(OAUTH_CALLBACK_TIMEOUT_SECS)) {
                Ok(mut stream) => {
                    let mut buf = [0u8; 8192];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let first_line = request.lines().next().unwrap_or("");
                    let result = parse_oauth_callback(first_line, &expected_state);

                    let body = if result.is_ok() {
                        "<html><body><h2>Twitch account connected.</h2><p>You can close this window and return to rahhh.</p></body></html>"
                    } else {
                        "<html><body><h2>Twitch connection failed.</h2><p>You can close this window and try again in rahhh.</p></body></html>"
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = tx.send(result);
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    let _ = tx.send(Err("Timed out waiting for Twitch sign-in — please try connecting again.".into()));
                }
                Err(_) => {
                    // The other listener (v4/v6) most likely already won the
                    // race and this one's just being torn down — no need to
                    // send a second error over an already-served channel.
                }
            }
        });
    }

    let code = match tokio::task::spawn_blocking(move || rx.recv()).await {
        Ok(Ok(Ok(code))) => code,
        Ok(Ok(Err(e))) => {
            app.emit("twitch-connect-error", e.clone()).ok();
            return Err(e);
        }
        Ok(Err(_)) | Err(_) => {
            let e = "Callback listener closed unexpectedly".to_string();
            app.emit("twitch-connect-error", e.clone()).ok();
            return Err(e);
        }
    };

    let http = reqwest::Client::new();
    let token_result = http
        .post("https://id.twitch.tv/oauth2/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("Token exchange request failed: {}", e));

    let resp = match token_result {
        Ok(r) => r,
        Err(e) => {
            app.emit("twitch-connect-error", e.clone()).ok();
            return Err(e);
        }
    };

    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            let e = format!("Token exchange response parse failed: {}", e);
            app.emit("twitch-connect-error", e.clone()).ok();
            return Err(e);
        }
    };

    let access_token = match json["access_token"].as_str() {
        Some(t) => t.to_string(),
        None => {
            let e = format!("Twitch did not return an access token: {}", json);
            app.emit("twitch-connect-error", e.clone()).ok();
            return Err(e);
        }
    };
    let refresh_token = match json["refresh_token"].as_str() {
        Some(t) => t.to_string(),
        None => {
            let e = "Twitch did not return a refresh token — try again.".to_string();
            app.emit("twitch-connect-error", e.clone()).ok();
            return Err(e);
        }
    };

    // Resolve which account was actually authorized so the UI can show it —
    // lets the user visually confirm they picked the right Twitch login.
    let whoami: serde_json::Value = match http
        .get("https://api.twitch.tv/helix/users")
        .header("Client-Id", client_id.as_str())
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
    {
        Ok(r) => r.json().await.unwrap_or(serde_json::Value::Null),
        Err(_) => serde_json::Value::Null,
    };
    let login = whoami["data"][0]["login"]
        .as_str()
        .unwrap_or("connected account")
        .to_string();

    let mut updates = HashMap::new();
    updates.insert(access_key, access_token);
    updates.insert(refresh_key, refresh_token);

    if let Err(e) = write_env_updates(&env_path, &updates) {
        app.emit("twitch-connect-error", e.clone()).ok();
        return Err(e);
    }

    app.emit("twitch-connected", &login).ok();
    Ok(login)
}

// Must be `async` and must use the plugin's non-blocking callback API, not
// blocking_pick_folder(): Tauri runs plain (non-async) commands directly on
// the main thread, and blocking_pick_folder() works by scheduling the actual
// dialog creation to *run on the main thread* via run_on_main_thread() and
// then blocking the caller until that finishes. If the caller already is
// the main thread, that's a deadlock with itself — which is exactly what
// froze the app. Bridging the callback through a oneshot channel and
// `.await`ing it keeps this off the main thread entirely.
#[tauri::command]
async fn pick_download_folder(app: tauri::AppHandle) -> Option<String> {
    let mut dialog = app.dialog().file();
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_folder(move |result| {
        let _ = tx.send(result);
    });

    rx.await.ok().flatten().map(|p| p.to_string())
}

#[tauri::command]
async fn pick_sfx_file(app: tauri::AppHandle) -> Option<String> {
    let mut dialog = app.dialog().file().add_filter("Audio", &["mp3", "wav", "ogg"]);
    if let Some(window) = app.get_webview_window("main") {
        dialog = dialog.set_parent(&window);
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    dialog.pick_file(move |result| {
        let _ = tx.send(result);
    });

    rx.await.ok().flatten().map(|p| p.to_string())
}

// Copies a user-picked audio file (from anywhere on disk) into the app's
// fixed sfx/ folder, so redeems/commands only ever need to reference a
// bare filename the bot's sfx server can serve — the original file is left
// untouched wherever the user picked it from.
#[tauri::command]
fn import_sfx_file(app: tauri::AppHandle, source_path: String) -> Result<String, String> {
    let sfx_dir = get_root(&app).join("sfx");
    fs::create_dir_all(&sfx_dir)
        .map_err(|e| format!("Cannot create sfx directory {:?}: {}", sfx_dir, e))?;

    let source = PathBuf::from(&source_path);
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["mp3", "wav", "ogg"].contains(&ext.as_str()) {
        return Err("Unsupported audio file type — pick an mp3, wav, or ogg file".into());
    }

    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("sound")
        .to_string();

    // Avoid clobbering an existing file with the same name — dedupe like a
    // normal OS copy/paste would ("airhorn.mp3" -> "airhorn (1).mp3").
    let mut dest_name = format!("{}.{}", stem, ext);
    let mut dest_path = sfx_dir.join(&dest_name);
    let mut n = 1;
    while dest_path.exists() {
        dest_name = format!("{} ({}).{}", stem, n, ext);
        dest_path = sfx_dir.join(&dest_name);
        n += 1;
    }

    fs::copy(&source, &dest_path).map_err(|e| format!("Failed to copy sound file: {}", e))?;
    Ok(dest_name)
}

// One-time migration from the standalone WordleChatV5 exe (missmeowzaki's
// previous setup — a separate process she started/stopped by hand) into
// this app's own data/wordleWins.json, so folding Wordle into rahhh doesn't
// wipe anyone's existing win count. Safe to run more than once: each
// user's count is the MAX of their existing and legacy values, never
// lowered, so re-running (or running it after she's already played some
// rounds in the new system) can't stomp newer progress or double-count.
#[tauri::command]
fn import_wordle_wins(app: tauri::AppHandle) -> Result<String, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "Could not resolve %APPDATA%.".to_string())?;
    let legacy_path = PathBuf::from(appdata).join("WordleChatGame").join("wins.json");

    if !legacy_path.exists() {
        return Err(format!(
            "No standalone Wordle leaderboard found at {:?}.",
            legacy_path
        ));
    }

    let legacy_raw = fs::read_to_string(&legacy_path)
        .map_err(|e| format!("Cannot read {:?}: {}", legacy_path, e))?;
    let legacy: HashMap<String, i64> =
        serde_json::from_str(&legacy_raw).map_err(|e| format!("Legacy wins.json is malformed: {}", e))?;

    let data_path = get_root(&app).join("data").join("wordleWins.json");
    let mut current: HashMap<String, i64> = if data_path.exists() {
        let raw = fs::read_to_string(&data_path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        HashMap::new()
    };

    let count = legacy.len();
    for (user, legacy_wins) in legacy {
        let entry = current.entry(user).or_insert(0);
        if legacy_wins > *entry {
            *entry = legacy_wins;
        }
    }

    if let Some(parent) = data_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(
        &data_path,
        serde_json::to_string_pretty(&current).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Cannot write {:?}: {}", data_path, e))?;

    Ok(format!("Imported {} legacy win record(s).", count))
}

fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

#[tauri::command]
async fn download_clip(app: tauri::AppHandle, clip_id: String, clip_title: String) -> Result<String, String> {
    // Read credentials from .env
    let env_path = get_root(&app).join("config").join(".env");
    let env_content = fs::read_to_string(&env_path).unwrap_or_default();

    let mut user_token = String::new();
    let mut download_dir_setting = String::new();

    for line in env_content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "MOD_USER_ACCESS_TOKEN" => user_token = v.trim().to_string(),
                "CLIP_DOWNLOAD_DIR" => download_dir_setting = v.trim().to_string(),
                _ => {}
            }
        }
    }

    let http = reqwest::Client::new();

    // Full query text — not a persisted hash, so it never goes stale
    let gql_query = "query VideoAccessToken_Clip($slug: ID!) { \
        clip(slug: $slug) { \
            playbackAccessToken(params: {platform: \"web\", playerType: \"pulsar\"}) { \
                signature value \
            } \
            videoQualities { frameRate quality sourceURL } \
        } \
    }";

    let body = serde_json::json!([{
        "operationName": "VideoAccessToken_Clip",
        "variables": { "slug": &clip_id },
        "query": gql_query
    }]);

    // GQL requires Twitch's own internal client ID — third-party IDs are rejected
    let mut builder = http
        .post("https://gql.twitch.tv/gql")
        .header("Client-ID", "kimne78kx3ncx6brgo4mv6wki5h1ko")
        .json(&body);

    if !user_token.is_empty() {
        builder = builder.header("Authorization", format!("Bearer {}", user_token));
    }

    let gql: serde_json::Value = builder
        .send()
        .await
        .map_err(|e| format!("GQL request failed: {}", e))?
        .json()
        .await
        .map_err(|e| format!("GQL parse failed: {}", e))?;

    let clip_data = &gql[0]["data"]["clip"];

    let qualities = clip_data["videoQualities"]
        .as_array()
        .ok_or_else(|| format!("No videoQualities — GQL response: {}", gql))?;

    if qualities.is_empty() {
        return Err("Clip has no downloadable qualities".into());
    }

    let best = qualities
        .iter()
        .max_by_key(|q| q["quality"].as_str().unwrap_or("0").parse::<i64>().unwrap_or(0))
        .ok_or("Could not pick quality")?;

    let source_url = best["sourceURL"].as_str().ok_or("Missing sourceURL")?;
    let sig = clip_data["playbackAccessToken"]["signature"]
        .as_str()
        .ok_or("Missing signature")?;
    let token_val = clip_data["playbackAccessToken"]["value"]
        .as_str()
        .ok_or("Missing token value")?;

    let download_url = format!("{}?sig={}&token={}", source_url, sig, percent_encode(token_val));

    let bytes = http
        .get(&download_url)
        .send()
        .await
        .map_err(|e| format!("Video fetch failed: {}", e))?
        .bytes()
        .await
        .map_err(|e| format!("Failed to read video: {}", e))?;

    let downloads_dir = if !download_dir_setting.is_empty() {
        std::path::PathBuf::from(&download_dir_setting)
    } else {
        std::env::var("USERPROFILE")
            .map(|p| std::path::PathBuf::from(p).join("Downloads"))
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
    };

    fs::create_dir_all(&downloads_dir)
        .map_err(|e| format!("Cannot create download directory {:?}: {}", downloads_dir, e))?;

    let safe_title: String = clip_title
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' })
        .collect();

    let file_path = downloads_dir.join(format!("{}.mp4", safe_title.trim()));

    fs::write(&file_path, &bytes)
        .map_err(|e| format!("Failed to save file: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(BotState {
            process: Mutex::new(None),
        })
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show rahhh", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("rahhh")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        if let Some(state) = app.try_state::<BotState>() {
                            if let Ok(mut lock) = state.process.lock() {
                                if let Some(child) = lock.as_mut() {
                                    let _ = child.kill();
                                }
                            }
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();

                if !TRAY_NOTICE_SHOWN.swap(true, Ordering::SeqCst) {
                    let _ = window
                        .app_handle()
                        .notification()
                        .builder()
                        .title("rahhh")
                        .body("Still running in the background — access it from the system tray.")
                        .show();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_bot,
            stop_bot,
            load_list,
            save_list,
            load_env,
            save_env,
            get_bot_stats,
            open_url,
            spotify_login,
            twitch_login,
            download_clip,
            pick_download_folder,
            pick_sfx_file,
            import_sfx_file,
            import_wordle_wins
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}