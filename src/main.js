const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* ---------- ACCENT COLOR THEME ---------- */
// The whole UI's accent palette is driven by CSS custom properties on :root
// (see the :root block at the top of style.css for the default values and
// every var(--accent-*) usage for what actually consumes them). This module
// just derives the rest of the palette from one picked color and overrides
// those properties live — nothing here needs a save/restart because CSS
// custom property changes repaint immediately.
const ACCENT_STORAGE_KEY = "rahhh-accent-color";
const DEFAULT_ACCENT = "#8b5cf6";
// Deliberately no purple preset here — running the default purple through
// the same HSL-derivation formula as every other swatch produces a palette
// that's subtly different from the hand-tuned :root defaults Reset restores,
// which made the swatch look like "back to default" without actually being
// pixel-identical to it. Red fills the hue gap instead.
const ACCENT_PRESETS = ["#ef4444", "#3b82f6", "#06b6d4", "#22c55e", "#f97316", "#ec4899"];
const ACCENT_VARS = [
  "--accent-rgb", "--accent", "--accent-dark", "--accent-darker",
  "--accent-light", "--accent-light-rgb", "--accent-lighter",
  "--accent-pale", "--accent-palest", "--accent-palest-rgb", "--accent-glow",
];

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [139, 92, 246];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s /= 100; l /= 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, "0")).join("")}`;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// HSV (not HSL) is what the picker panel itself works in — a saturation x
// value square fills edge-to-edge and matches how every other color picker
// (browser native ones included) lays itself out, unlike an HSL square which
// bunches colors toward the middle. The derived theme palette above still
// works in HSL; these two representations are independent.
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360 / 360;
  s /= 100; v /= 100;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d) % 6; break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return [h, s * 100, max * 100];
}

let currentAccentHex = DEFAULT_ACCENT;

// Derives the app's full accent palette (dark/light/pale/glow shades) from a
// single picked color, at fixed target lightness levels rather than offsets
// from the base color's own lightness — offsets made "palest" land wherever
// base-lightness-plus-40 happened to fall, which meant a light base hue
// (like the default purple, ~66% L) got clamped to a genuinely near-white
// palest, while a darker base hue (like cyan, ~43% L) never got there and
// stayed clearly saturated. Fixed absolute targets keep every hue's ramp —
// and the gradient text it drives — looking the same relative to itself.
function applyAccentTheme(hex) {
  currentAccentHex = hex;
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);

  const shade = (targetL, targetS) => {
    const [sr, sg, sb] = hslToRgb(h, clamp(targetS, 0, 100), clamp(targetL, 4, 97));
    return { rgb: `${sr}, ${sg}, ${sb}`, hex: rgbToHex(sr, sg, sb) };
  };

  const base = shade(l, s);
  const dark = shade(50, s + 4);
  const darker = shade(40, s + 6);
  const light = shade(72, s);
  const lighter = shade(82, s - 8);
  const pale = shade(90, s * 0.5);
  const palest = shade(95, s * 0.28);
  const glow = shade(76, s + 6);

  const root = document.documentElement.style;
  root.setProperty("--accent-rgb", base.rgb);
  root.setProperty("--accent", base.hex);
  root.setProperty("--accent-dark", dark.hex);
  root.setProperty("--accent-darker", darker.hex);
  root.setProperty("--accent-light", light.hex);
  root.setProperty("--accent-light-rgb", light.rgb);
  root.setProperty("--accent-lighter", lighter.hex);
  root.setProperty("--accent-pale", pale.hex);
  root.setProperty("--accent-palest", palest.hex);
  root.setProperty("--accent-palest-rgb", palest.rgb);
  root.setProperty("--accent-glow", glow.hex);

  window.SideRays?.instance?.setOptions({ rayColor1: light.hex, rayColor2: darker.hex });

  updateAccentUI(hex);
}

function resetAccentTheme() {
  localStorage.removeItem(ACCENT_STORAGE_KEY);
  currentAccentHex = DEFAULT_ACCENT;
  const root = document.documentElement.style;
  ACCENT_VARS.forEach(name => root.removeProperty(name));

  window.SideRays?.instance?.setOptions({ rayColor1: "#A78BFA", rayColor2: "#6D28D9" });

  updateAccentUI(DEFAULT_ACCENT);
}

function updateAccentUI(hex) {
  const trigger = document.getElementById("accentPickerTrigger");
  if (trigger) trigger.style.background = hex;

  document.querySelectorAll(".accent-swatch").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.color.toLowerCase() === hex.toLowerCase());
  });
}

// Custom picker's own working state, independent of the derived theme
// palette above — only pushed INTO the theme on drag/type, and only pulled
// back FROM the current theme once, when the popover opens.
let pickerHue = 258, pickerS = 90, pickerV = 96;

function syncPickerFromHex(hex) {
  const [r, g, b] = hexToRgb(hex);
  [pickerHue, pickerS, pickerV] = rgbToHsv(r, g, b);
}

function hexFromPicker() {
  const [r, g, b] = hsvToRgb(pickerHue, pickerS, pickerV);
  return rgbToHex(r, g, b);
}

function renderPicker() {
  const hex = hexFromPicker();
  const slPanel = document.getElementById("colorSlPanel");
  const slCursor = document.getElementById("colorSlCursor");
  const hueCursor = document.getElementById("colorHueCursor");
  const preview = document.getElementById("colorPreview");
  const hexInput = document.getElementById("colorHexInput");

  const pureHue = rgbToHex(...hsvToRgb(pickerHue, 100, 100));
  slPanel.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pureHue})`;

  slCursor.style.left = `${pickerS}%`;
  slCursor.style.top = `${100 - pickerV}%`;
  hueCursor.style.left = `${(pickerHue / 360) * 100}%`;

  preview.style.background = hex;
  if (document.activeElement !== hexInput) hexInput.value = hex.toUpperCase();
}

// Generic color popover — the accent picker (Settings) and the redeem
// background-color picker both drive the same DOM instance, one caller at a
// time. openColorPopover/toggleColorPopover take an onChange callback so
// each caller decides what a picked color actually does; the drag/hex-input
// handlers below just call commitPickerColor(), which forwards to whichever
// callback is currently active.
let colorPopoverOnChange = null;
let colorPopoverTrigger = null;

function commitPickerColor() {
  const hex = hexFromPicker();
  if (colorPopoverOnChange) colorPopoverOnChange(hex);
}

function openColorPopover(trigger, hex, onChange) {
  const popover = document.getElementById("accentColorPopover");
  colorPopoverTrigger = trigger;
  colorPopoverOnChange = onChange;

  syncPickerFromHex(hex);
  renderPicker();

  const rect = trigger.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 8}px`;
  popover.style.left = `${rect.left}px`;
  popover.classList.add("open");
}

function closeColorPopover() {
  document.getElementById("accentColorPopover").classList.remove("open");
  colorPopoverOnChange = null;
  colorPopoverTrigger = null;
}

function toggleColorPopover(trigger, hex, onChange) {
  const popover = document.getElementById("accentColorPopover");
  if (popover.classList.contains("open") && colorPopoverTrigger === trigger) {
    closeColorPopover();
  } else {
    openColorPopover(trigger, hex, onChange);
  }
}

function initColorPopover() {
  const popover = document.getElementById("accentColorPopover");
  if (!popover) return;

  document.body.appendChild(popover);

  const slPanel = document.getElementById("colorSlPanel");
  const hueSlider = document.getElementById("colorHueSlider");
  const hexInput = document.getElementById("colorHexInput");

  document.addEventListener("click", (e) => {
    if (popover.classList.contains("open") && !popover.contains(e.target) && e.target !== colorPopoverTrigger) {
      closeColorPopover();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeColorPopover();
  });

  // Any scrollable container the trigger could live in — Settings page or
  // a modal body — closes the popover rather than letting it drift away
  // from the button that opened it.
  document.querySelectorAll(".modal-body").forEach((el) => el.addEventListener("scroll", closeColorPopover));
  settingsPage.addEventListener("scroll", closeColorPopover);

  function pointFromEvent(el, e) {
    const rect = el.getBoundingClientRect();
    return {
      x: clamp(e.clientX - rect.left, 0, rect.width),
      y: clamp(e.clientY - rect.top, 0, rect.height),
      rect,
    };
  }

  function bindDrag(el, onDrag) {
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      onDrag(e);

      const onMove = (ev) => onDrag(ev);
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    });
  }

  bindDrag(slPanel, (e) => {
    const { x, y, rect } = pointFromEvent(slPanel, e);
    pickerS = (x / rect.width) * 100;
    pickerV = 100 - (y / rect.height) * 100;
    renderPicker();
    commitPickerColor();
  });

  bindDrag(hueSlider, (e) => {
    const { x, rect } = pointFromEvent(hueSlider, e);
    pickerHue = (x / rect.width) * 360;
    renderPicker();
    commitPickerColor();
  });

  hexInput.addEventListener("change", () => {
    const raw = hexInput.value.trim();
    const hex = raw.startsWith("#") ? raw : `#${raw}`;
    if (!/^#[0-9a-f]{6}$/i.test(hex)) {
      hexInput.value = hexFromPicker().toUpperCase();
      return;
    }
    syncPickerFromHex(hex);
    renderPicker();
    commitPickerColor();
  });
}

function initAccentTheme() {
  const swatchContainer = document.getElementById("accentSwatches");
  if (swatchContainer) {
    ACCENT_PRESETS.forEach(color => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "accent-swatch";
      btn.dataset.color = color;
      btn.style.background = color;
      btn.title = color;
      btn.onclick = () => {
        localStorage.setItem(ACCENT_STORAGE_KEY, color);
        applyAccentTheme(color);
      };
      swatchContainer.appendChild(btn);
    });
  }

  initColorPopover();

  const accentTrigger = document.getElementById("accentPickerTrigger");
  if (accentTrigger) {
    accentTrigger.onclick = (e) => {
      e.stopPropagation();
      toggleColorPopover(accentTrigger, currentAccentHex, (hex) => {
        localStorage.setItem(ACCENT_STORAGE_KEY, hex);
        applyAccentTheme(hex);
      });
    };
  }

  const resetBtn = document.getElementById("resetAccentColor");
  if (resetBtn) resetBtn.onclick = resetAccentTheme;

  const saved = localStorage.getItem(ACCENT_STORAGE_KEY);
  if (saved) applyAccentTheme(saved);
  else updateAccentUI(DEFAULT_ACCENT);
}

// Deferred to DOMContentLoaded (rather than run immediately here) so that
// sideRays.js — whose own DOMContentLoaded listener registers earlier in
// document order — has already set window.SideRays.instance by the time
// this runs and tries to retint it.
document.addEventListener("DOMContentLoaded", initAccentTheme);

const statusEl = document.getElementById("status");

const dashNav = document.getElementById("dashNav");
const listsNav = document.getElementById("listsNav");

const dashboard = document.querySelector(".dashboard");
const listsPage = document.getElementById("listsPage");

const allowBox = document.getElementById("allowlistBox");
const vipBox = document.getElementById("viplistBox");
const allowlistCount = document.getElementById("allowlistCount");
const viplistCount = document.getElementById("viplistCount");

function updateListCount(textarea, countEl) {
  countEl.textContent = textarea.value.split("\n").filter(x => x.trim()).length;
}

allowBox.oninput = () => updateListCount(allowBox, allowlistCount);
vipBox.oninput = () => updateListCount(vipBox, viplistCount);


const navButtons = document.querySelectorAll(".nav-btn");

const settingsNav = document.getElementById("settingsNav");
const settingsPage = document.getElementById("settingsPage");

const toggleBotGlow = document.getElementById("toggleBotGlow");
const powerGlow = BorderGlow.init(toggleBotGlow, {
  wrap: true,
  borderRadius: 999,
  glowRadius: 22,
  edgeSensitivity: 25,
  coneSpread: 30,
});

// Subtle neutral gray/white glow while stopped (no purple); dim translucent
// red once the bot is actually running.
function setPowerGlowTheme(running) {
  if (running) {
    powerGlow.setGlowColor("0 70% 55%", 0.55);
    powerGlow.setColors(["#b91c1c", "#991b1b", "#7f1d1d"]);
  } else {
    powerGlow.setGlowColor("0 0% 85%", 0.4);
    powerGlow.setColors(["#9ca3af", "#d1d5db", "#e5e7eb"]);
  }
}
setPowerGlowTheme(false);

function setActive(btn) {
  navButtons.forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
}

const logsPage = document.getElementById("logsPage");
const clipsPage = document.getElementById("clipsPage");
const snacksPage = document.getElementById("snacksPage");
const commandsPage = document.getElementById("commandsPage");
const redeemsPage = document.getElementById("redeemsPage");
const songsPage = document.getElementById("songsPage");

const pages = [
  dashboard,
  listsPage,
  clipsPage,
  snacksPage,
  commandsPage,
  redeemsPage,
  songsPage,
  logsPage,
  settingsPage,
];

listen("bot-ready", () => {
  botRunning = true;
  botStarting = false;
  setPowerGlowTheme(true);

  toggleBtn.textContent = "⏻ Stop Bot";
  toggleBtn.disabled = false;
  toggleBtn.style.opacity = 1;
  toggleBtn.classList.add("running");

  statusEl.textContent = "● Bot Running";
  statusEl.classList.remove("stopped");
  statusEl.classList.add("running");
});

// Fires when the Node process dies for any reason, including a normal
// stop_bot() kill. If we already know it's stopped (manual stop already
// reset these flags), this is just confirming what we know — no-op. But if
// the bot was starting or running and never told us otherwise, it crashed
// unexpectedly, so recover the button instead of leaving it stuck forever.
listen("bot-exited", () => {
  if (!botRunning && !botStarting) return;

  botRunning = false;
  botStarting = false;
  setPowerGlowTheme(false);

  toggleBtn.textContent = "⏻ Start Bot";
  toggleBtn.disabled = false;
  toggleBtn.style.opacity = 1;
  toggleBtn.classList.remove("running");

  statusEl.textContent = "● Bot Stopped (crashed unexpectedly)";
  statusEl.classList.remove("running");
  statusEl.classList.add("stopped");
});

// Mirrors the bot's own !time resolution: use TIME_TIMEZONE, and if it's not
// a valid IANA name fall back to UTC rather than silently guessing.
function getTimePeriod(timezone) {
  let hour;
  try {
    hour = parseInt(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).format(new Date()),
      10
    );
  } catch {
    hour = parseInt(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: "UTC" }).format(new Date()),
      10
    );
  }

  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
}

const GREETING_LABELS = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" };

// Minimal feather-style line icons (stroke uses currentColor, see .greeting-icon in style.css)
const GREETING_ICONS = {
  morning: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 15a6 6 0 0 1 12 0"/>
    <line x1="3" y1="18" x2="21" y2="18"/>
    <line x1="12" y1="5" x2="12" y2="8"/>
    <line x1="5.5" y1="9" x2="7.5" y2="11"/>
    <line x1="18.5" y1="9" x2="16.5" y2="11"/>
  </svg>`,
  afternoon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="12" cy="12" r="4.2"/>
    <line x1="12" y1="2.5" x2="12" y2="4.8"/>
    <line x1="12" y1="19.2" x2="12" y2="21.5"/>
    <line x1="2.5" y1="12" x2="4.8" y2="12"/>
    <line x1="19.2" y1="12" x2="21.5" y2="12"/>
    <line x1="5.1" y1="5.1" x2="6.7" y2="6.7"/>
    <line x1="17.3" y1="17.3" x2="18.9" y2="18.9"/>
    <line x1="5.1" y1="18.9" x2="6.7" y2="17.3"/>
    <line x1="17.3" y1="6.7" x2="18.9" y2="5.1"/>
  </svg>`,
  evening: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
  </svg>`,
};

async function refreshDashboard() {
  // Runs on a 4s interval regardless of which page is active — skip the
  // IPC round-trips (and the disk reads they trigger on the Rust side)
  // entirely when Dashboard isn't even visible, or when the whole window
  // is hidden/minimized (e.g. tray-minimized while gaming/streaming).
  if (dashboard.style.display === "none") return;
  if (document.hidden) return;

  try {
    const stats = await invoke("get_bot_stats");
    const env = await invoke("load_env");

    const period = getTimePeriod(env.TIME_TIMEZONE || "Asia/Almaty");
    const streamerName = capitalize(env.TARGET_CHANNEL_LOGIN || "");

    document.getElementById("greetingIcon").innerHTML = GREETING_ICONS[period];
    document.getElementById("dashboardGreeting").textContent = streamerName
      ? `${GREETING_LABELS[period]}, ${streamerName}`
      : `${GREETING_LABELS[period]},`;

    document.getElementById("allowCount").textContent =
      stats.allowlist;

    document.getElementById("vipCount").textContent =
      stats.viplist;
  } catch (e) {
    console.error(e);
  }

  try {
    const now = await invoke("load_list", { name: "nowPlaying" });
    document.getElementById("dashboardNowPlaying").textContent = now
      ? `${now.title} - ${now.artist} ${now.isPlaying ? "▶" : "⏸"}`
      : "—";
  } catch (e) {
    document.getElementById("dashboardNowPlaying").textContent = "—";
  }
}

const logContainer = document.getElementById("logs");
const autoScrollBox = document.getElementById("autoScroll");

let logFilter = "all";

// Clear logs
document.getElementById("clearLogs").onclick = () => {
  const btn = document.getElementById("clearLogs");

  document.getElementById("logs").innerHTML = "";

  btn.textContent = "Cleared";
  setTimeout(() => btn.textContent = "Clear", 1200);
};

// Copy logs
document.getElementById("copyLogs").onclick = async () => {
  const btn = document.getElementById("copyLogs");

  await navigator.clipboard.writeText(
    document.getElementById("logs").innerText
  );

  btn.classList.add("copied");

  setTimeout(() => {
    btn.classList.remove("copied");
  }, 1200);
};

// Filters
document.querySelectorAll(".filter-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".filter-btn")
      .forEach(b => b.classList.remove("active"));

    btn.classList.add("active");
    logFilter = btn.dataset.filter;

    document.querySelectorAll(".log-line").forEach(line => {
      if (logFilter === "all" || line.dataset.type === logFilter)
        line.style.display = "block";
      else
        line.style.display = "none";
    });
  };
});

// Listen for logs
listen("bot-log", event => {
  const text = event.payload;

  const line = document.createElement("div");
  line.textContent = text;
  line.classList.add("log-line");

  // classify log type
  if (text.includes("ERR"))
    line.dataset.type = "error";
  else if (text.includes("SO") || text.includes("Loaded"))
    line.dataset.type = "bot";
  else
    line.dataset.type = "info";

  logContainer.appendChild(line);

  if (autoScrollBox.checked) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
});

function showPage(pageToShow) {
  pages.forEach(p => p.style.display = "none");
  pageToShow.style.display = "";
}

const toggleBtn = document.getElementById("toggleBot");
let botRunning = false;
let botStarting = false;
toggleBtn.onclick = async () => {
  try {
    if (!botRunning) {
      await invoke("start_bot");
      botRunning = false;
      botStarting = true;

      toggleBtn.textContent = "Starting...";
      toggleBtn.disabled = true;
      toggleBtn.style.opacity = 0.6;

      statusEl.textContent = "● Connecting to Twitch...";
      statusEl.classList.remove("stopped");
      statusEl.classList.add("running");
    } else {
      await invoke("stop_bot");
      botRunning = false;
      botStarting = false;
      setPowerGlowTheme(false);

      toggleBtn.textContent = "⏻ Start Bot";
      toggleBtn.classList.remove("running");

      statusEl.textContent = "● Bot Stopped";
      statusEl.classList.remove("running");
      statusEl.classList.add("stopped");
    }

    refreshDashboard();
  } catch (err) {
    console.error(err);
  }
};

/* ---------- NAVIGATION ---------- */

dashNav.onclick = () => {
  setActive(dashNav);
  showPage(dashboard);
};

listsNav.onclick = async () => {
  setActive(listsNav);
  showPage(listsPage);

  try {
    const allow = await invoke("load_list", { name: "allowlist" });
    const vip = await invoke("load_list", { name: "VIPList" });

    allowBox.value = (allow.users || []).join("\n");
    vipBox.value = (vip.users || []).join("\n");
    updateListCount(allowBox, allowlistCount);
    updateListCount(vipBox, viplistCount);
  } catch (err) {
    console.error(err);
  }
};

const logsNav = document.getElementById("logsNav");

logsNav.onclick = () => {
  setActive(logsNav);
  showPage(logsPage);

  setTimeout(() => {
    const logBox = document.querySelector(".logs-container");

    if (autoScrollBox.checked && logBox) {
      logBox.scrollTop = logBox.scrollHeight;
    }
  }, 100);
};
/* ---------- SAVE LISTS ---------- */

document.getElementById("saveLists").onclick = async () => {
  const allow = {
    users: allowBox.value.split("\n").map(x => x.trim()).filter(Boolean),
  };

  const vip = {
    users: vipBox.value.split("\n").map(x => x.trim()).filter(Boolean),
  };

  await invoke("save_list", { name: "allowlist", content: allow });
  await invoke("save_list", { name: "VIPList", content: vip });

  alert("Lists saved!");
};


/* ---------- SETTINGS PAGE ---------- */

// One representative zone per major UTC offset, rather than the full
// ~400-entry IANA list Intl.supportedValuesOf() would give — nobody needs
// to pick between Europe/Paris and Europe/Berlin here.
const CURATED_TIMEZONES = [
  "UTC",
  "Pacific/Honolulu",
  "America/Anchorage",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Atlantic/Azores",
  "Europe/London",
  "Europe/Paris",
  "Europe/Athens",
  "Europe/Moscow",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Almaty",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Pacific/Auckland",
];

function setTimezoneValue(tz) {
  document.getElementById("timeTimezone").value = tz;
  document.getElementById("timeTimezoneBtn").textContent = tz;
  document.querySelectorAll(".tz-option").forEach(opt => {
    opt.classList.toggle("selected", opt.dataset.value === tz);
  });
}

function initTimezoneDropdown() {
  const dropdown = document.getElementById("timeTimezoneDropdown");
  const btn = document.getElementById("timeTimezoneBtn");
  const list = document.getElementById("timeTimezoneList");
  if (list.childElementCount) return;

  list.innerHTML = CURATED_TIMEZONES
    .map(z => `<div class="tz-option" data-value="${z}">${z}</div>`)
    .join("");

  // Settings cards use backdrop-filter, which creates a new stacking
  // context per card — a z-index inside one card can never paint above a
  // later sibling card no matter how high it's set. Moving the popup out
  // to <body> and positioning it with fixed coords sidesteps that.
  document.body.appendChild(list);

  function openList() {
    const rect = btn.getBoundingClientRect();
    list.style.position = "fixed";
    list.style.top = `${rect.bottom + 6}px`;
    list.style.left = `${rect.left}px`;
    list.style.width = `${rect.width}px`;
    list.classList.add("open");
    dropdown.classList.add("open");
  }

  function closeList() {
    list.classList.remove("open");
    dropdown.classList.remove("open");
  }

  list.querySelectorAll(".tz-option").forEach(opt => {
    opt.onclick = () => {
      setTimezoneValue(opt.dataset.value);
      closeList();
    };
  });

  btn.onclick = (e) => {
    e.stopPropagation();
    if (list.classList.contains("open")) closeList();
    else openList();
  };

  document.addEventListener("click", (e) => {
    if (!list.contains(e.target) && e.target !== btn) closeList();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeList();
  });

  // The popup's position is computed once at open time; if the settings
  // page scrolls underneath it, just close it rather than let it drift
  // away from the button.
  settingsPage.addEventListener("scroll", closeList);
}

document.getElementById("browseDownloadLocation").onclick = async () => {
  try {
    const folder = await invoke("pick_download_folder");
    if (folder) document.getElementById("downloadLocation").value = folder;
  } catch (err) {
    console.error("[BROWSE] pick_download_folder failed:", err);
    alert("Couldn't open the folder picker:\n" + err);
  }
};

document.getElementById("copySfxOverlayUrl").onclick = async () => {
  const btn = document.getElementById("copySfxOverlayUrl");
  await navigator.clipboard.writeText(document.getElementById("sfxOverlayUrl").value);
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = "Copy"; }, 1200);
};

/* ---------- UPDATES ---------- */

document.getElementById("checkForUpdates").onclick = async () => {
  const btn = document.getElementById("checkForUpdates");
  const statusEl = document.getElementById("updateStatus");
  btn.disabled = true;
  statusEl.textContent = "Checking…";

  try {
    const update = await window.__TAURI__.updater.check();
    if (!update) {
      statusEl.textContent = "You're up to date.";
      return;
    }

    statusEl.textContent = `Update ${update.version} found, downloading…`;
    let downloaded = 0;
    let total = 0;

    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength || 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        statusEl.textContent = total
          ? `Downloading… ${Math.round((downloaded / total) * 100)}%`
          : "Downloading…";
      } else if (event.event === "Finished") {
        statusEl.textContent = "Installed, restarting…";
      }
    });

    await window.__TAURI__.process.relaunch();
  } catch (e) {
    statusEl.textContent = "Update check failed: " + e;
  } finally {
    btn.disabled = false;
  }
};

settingsNav.onclick = async () => {
  setActive(settingsNav);
  showPage(settingsPage);

  try {
    document.getElementById("appVersion").textContent = await window.__TAURI__.app.getVersion();
  } catch (err) {
    console.error(err);
  }

  initTimezoneDropdown();

  const env = await invoke("load_env");

  document.getElementById("twitchClientId").value = env.TWITCH_CLIENT_ID || "";
  document.getElementById("twitchClientSecret").value = env.TWITCH_CLIENT_SECRET || "";
  document.getElementById("streamerUserToken").value = env.STREAMER_USER_ACCESS_TOKEN || "";
  document.getElementById("streamerRefreshToken").value = env.STREAMER_REFRESH_TOKEN || "";
  document.getElementById("botUserToken").value = env.BOT_USER_ACCESS_TOKEN || "";
  document.getElementById("botRefreshToken").value = env.BOT_REFRESH_TOKEN || "";
  document.getElementById("userToken").value = env.MOD_USER_ACCESS_TOKEN || "";
  document.getElementById("refreshToken").value = env.MOD_REFRESH_TOKEN || "";
  document.getElementById("targetChannel").value = env.TARGET_CHANNEL_LOGIN || "";
  document.getElementById("modLogin").value = env.MOD_LOGIN || "";
  if (env.TARGET_CHANNEL_LOGIN) document.getElementById("streamerConnectStatus").textContent = `✓ Connected as ${env.TARGET_CHANNEL_LOGIN}`;
  if (env.MOD_LOGIN) document.getElementById("modConnectStatus").textContent = `✓ Connected as ${env.MOD_LOGIN}`;
  document.getElementById("discordWebhook").value = env.DISCORD_WEBHOOK_URL || "";
  document.getElementById("downloadLocation").value = env.CLIP_DOWNLOAD_DIR || "";
  document.getElementById("sfxOverlayUrl").value = `http://localhost:${env.SFX_SERVER_PORT || 8420}/overlay`;
  setTimezoneValue(env.TIME_TIMEZONE || "Asia/Almaty");
};

document.getElementById("saveSettings").onclick = async () => {
  const btn = document.getElementById("saveSettings");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const env = {
      TWITCH_CLIENT_ID: document.getElementById("twitchClientId").value,
      TWITCH_CLIENT_SECRET: document.getElementById("twitchClientSecret").value,
      STREAMER_USER_ACCESS_TOKEN: document.getElementById("streamerUserToken").value,
      STREAMER_REFRESH_TOKEN: document.getElementById("streamerRefreshToken").value,
      BOT_USER_ACCESS_TOKEN: document.getElementById("botUserToken").value,
      BOT_REFRESH_TOKEN: document.getElementById("botRefreshToken").value,
      MOD_USER_ACCESS_TOKEN: document.getElementById("userToken").value,
      MOD_REFRESH_TOKEN: document.getElementById("refreshToken").value,
      DISCORD_WEBHOOK_URL: document.getElementById("discordWebhook").value,
      CLIP_DOWNLOAD_DIR: document.getElementById("downloadLocation").value,
      TIME_TIMEZONE: document.getElementById("timeTimezone").value,
    };

    await invoke("save_env", { env });

    // Only restart if it was actually running — otherwise this was just
    // turning the bot on as a side effect of saving settings.
    if (botRunning) {
      await invoke("stop_bot");
      await invoke("start_bot");
    }

    btn.textContent = "Saved!";
    setTimeout(() => { btn.textContent = "Save & Restart Bot"; btn.disabled = false; }, 2000);
  } catch (e) {
    alert("Error saving settings: " + e);
    btn.textContent = "Save & Restart Bot";
    btn.disabled = false;
  }
};

document.getElementById("copyTwitchRedirectUri").onclick = async () => {
  const btn = document.getElementById("copyTwitchRedirectUri");
  await navigator.clipboard.writeText(document.getElementById("twitchRedirectUri").value);
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = "Copy"; }, 1200);
};

document.getElementById("openTwitchDevConsole").onclick = () =>
  invoke("open_url", { url: "https://dev.twitch.tv/console/apps" });

// Shared by the three Connect buttons below — runs the full Twitch OAuth
// flow via the Rust twitch_login command, then re-reads .env so the visible
// token fields reflect whatever actually got written (rather than trusting
// the invoke() return value, which only carries the connected login name).
async function connectTwitchAccount(scopes, accessKey, refreshKey, accessFieldId, refreshFieldId, statusElId, btn, extraLoginKey = null, extraFieldId = null) {
  const statusEl = document.getElementById(statusElId);
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Connecting… (check your browser)";
  statusEl.textContent = "";

  try {
    const login = await invoke("twitch_login", { scopes, accessKey, refreshKey });

    // Streamer/Mod connect resolves the actual Twitch login of whichever
    // account got authorized — that's the real source of truth for
    // TARGET_CHANNEL_LOGIN/MOD_LOGIN now, replacing the old manually-typed
    // Settings fields. The readonly display field updates immediately
    // rather than waiting for the next time Settings happens to reload.
    if (extraLoginKey) {
      await invoke("save_env", { env: { [extraLoginKey]: login } });
      if (extraFieldId) document.getElementById(extraFieldId).value = login;
    }

    const env = await invoke("load_env");
    document.getElementById(accessFieldId).value = env[accessKey] || "";
    document.getElementById(refreshFieldId).value = env[refreshKey] || "";
    statusEl.textContent = `✓ Connected as ${login}`;

    if (botRunning) {
      await invoke("stop_bot");
      await invoke("start_bot");
    }
  } catch (e) {
    alert("Twitch connection failed:\n" + e);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// Broader than what the bot currently uses on purpose — future-proofs the
// streamer token against features that aren't wired up yet (polls,
// predictions, ban/message moderation, chatters, followers) so reconnecting
// isn't needed later just to add a scope.
document.getElementById("connectStreamer").onclick = (e) =>
  connectTwitchAccount(
    "channel:manage:broadcast channel:manage:polls channel:manage:predictions channel:manage:redemptions " +
      "channel:read:polls channel:read:predictions channel:read:redemptions channel:read:subscriptions " +
      "chat:edit chat:read clips:edit moderator:manage:banned_users moderator:manage:chat_messages " +
      "moderator:manage:shoutouts moderator:read:chatters moderator:read:followers user:write:chat",
    "STREAMER_USER_ACCESS_TOKEN", "STREAMER_REFRESH_TOKEN",
    "streamerUserToken", "streamerRefreshToken",
    "streamerConnectStatus", e.currentTarget,
    "TARGET_CHANNEL_LOGIN", "targetChannel"
  );

document.getElementById("connectBot").onclick = (e) =>
  connectTwitchAccount(
    "user:read:chat user:write:chat user:bot",
    "BOT_USER_ACCESS_TOKEN", "BOT_REFRESH_TOKEN",
    "botUserToken", "botRefreshToken",
    "botConnectStatus", e.currentTarget
  );

document.getElementById("connectMod").onclick = (e) =>
  connectTwitchAccount(
    "clips:edit",
    "MOD_USER_ACCESS_TOKEN", "MOD_REFRESH_TOKEN",
    "userToken", "refreshToken",
    "modConnectStatus", e.currentTarget,
    "MOD_LOGIN", "modLogin"
  );

document.querySelectorAll(".toggle-vis[data-target]").forEach(btn => {
  btn.onclick = () => {
    const input = document.getElementById(btn.dataset.target);
    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";
    btn.textContent = hidden ? "Hide" : "Show";
  };
});
/* ---------- CLIPS PAGE ---------- */
const clipsNav = document.getElementById("clipsNav");
let clipsLoaded = false;

clipsNav.onclick = () => {
  setActive(clipsNav);
  showPage(clipsPage);
  if (!clipsLoaded) loadClips();
};

document.getElementById("refreshClips").onclick = () => loadClips();

async function loadClips() {
  const grid = document.getElementById("clipsGrid");
  const meta = document.getElementById("clipsMeta");

  grid.innerHTML = '<div class="clips-empty">Loading clips…</div>';
  meta.textContent = "";
  clipsLoaded = false;

  try {
    const env = await invoke("load_env");
    const token = env.MOD_USER_ACCESS_TOKEN;
    const clientId = env.TWITCH_CLIENT_ID;
    const channel = env.TARGET_CHANNEL_LOGIN;

    if (!token || !clientId || !channel) {
      grid.innerHTML = '<div class="clips-empty">Missing TWITCH_CLIENT_ID, MOD_USER_ACCESS_TOKEN, or TARGET_CHANNEL_LOGIN in config.</div>';
      return;
    }

    const headers = {
      Authorization: `Bearer ${token}`,
      "Client-Id": clientId,
    };

    const usersRes = await fetch(`https://api.twitch.tv/helix/users?login=${channel}`, { headers });
    const usersData = await usersRes.json();
    const broadcasterId = usersData.data?.[0]?.id;
    if (!broadcasterId) throw new Error("Could not resolve broadcaster ID, check your token.");

    let startedAt = null;
    let streamLabel = "";

    const streamRes = await fetch(`https://api.twitch.tv/helix/streams?user_id=${broadcasterId}`, { headers });
    const streamData = await streamRes.json();

    if (streamData.data?.length > 0) {
      startedAt = streamData.data[0].started_at;
      streamLabel = '<span class="live-badge"><span class="live-dot"></span>Live now</span>';
    } else {
      const vodRes = await fetch(
        `https://api.twitch.tv/helix/videos?user_id=${broadcasterId}&type=archive&first=1`,
        { headers }
      );
      const vodData = await vodRes.json();
      if (vodData.data?.length > 0) {
        startedAt = vodData.data[0].created_at;
        const d = new Date(startedAt);
        streamLabel = `Last stream: ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      }
    }

    let clipsUrl = `https://api.twitch.tv/helix/clips?broadcaster_id=${broadcasterId}&first=100`;
    if (startedAt) clipsUrl += `&started_at=${encodeURIComponent(startedAt)}`;

    const clipsRes = await fetch(clipsUrl, { headers });
    const clipsData = await clipsRes.json();
    const clips = clipsData.data || [];

    const count = `${clips.length} clip${clips.length !== 1 ? "s" : ""}`;
    meta.innerHTML = streamLabel ? `${streamLabel}  ·  ${count}` : count;

    if (!clips.length) {
      grid.innerHTML = '<div class="clips-empty">No clips found for the latest stream.</div>';
      clipsLoaded = true;
      return;
    }

    grid.innerHTML = "";
    for (const clip of clips) {
      const card = document.createElement("div");
      card.className = "clip-card";
      const title = escapeHtml(clip.title);
      card.innerHTML = `
        <div class="clip-thumb-wrap">
          <img src="${clip.thumbnail_url}" alt="${title}" loading="lazy">
          <button class="clip-play-btn" aria-label="Play clip" title="Play clip">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <div class="clip-overlay">
            <button class="clip-btn clip-open-btn">Open in Twitch</button>
            <button class="clip-btn clip-dl-btn">Download</button>
          </div>
        </div>
        <div class="clip-controls">
          <button class="clip-btn clip-open-btn">Open in Twitch</button>
          <button class="clip-btn clip-dl-btn">Download</button>
        </div>
        <div class="clip-info">
          <div class="clip-title" title="${title}">${title}</div>
          <div class="clip-creator">${escapeHtml(clip.creator_name)} · ${clip.view_count.toLocaleString()} views</div>
        </div>
      `;

      const thumbWrap = card.querySelector(".clip-thumb-wrap");

      const playInline = () => {
        if (thumbWrap.classList.contains("playing")) return;

        // Twitch's clip embed rejects loading unless `parent` matches the
        // embedding page's actual hostname — reading it live instead of
        // guessing a string is what makes this work inside Tauri's
        // custom-protocol webview (tauri.localhost), not just a browser.
        const parent = window.location.hostname;
        const embedUrl = `https://clips.twitch.tv/embed?clip=${encodeURIComponent(clip.id)}&parent=${parent}&autoplay=true`;

        const iframe = document.createElement("iframe");
        iframe.src = embedUrl;
        iframe.allow = "autoplay; encrypted-media; fullscreen; picture-in-picture";
        iframe.allowFullscreen = true;
        iframe.setAttribute("frameborder", "0");

        thumbWrap.querySelector("img").replaceWith(iframe);
        thumbWrap.classList.add("playing");
      };

      thumbWrap.querySelector("img").onclick = playInline;
      card.querySelector(".clip-play-btn").onclick = (e) => {
        e.stopPropagation();
        playInline();
      };

      card.querySelectorAll(".clip-open-btn").forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          invoke("open_url", { url: clip.url });
        };
      });

      card.querySelectorAll(".clip-dl-btn").forEach(btn => {
        btn.onclick = async (e) => {
          e.stopPropagation();
          const clicked = e.currentTarget;
          clicked.textContent = "Downloading...";
          clicked.disabled = true;
          try {
            await invoke("download_clip", { clipId: clip.id, clipTitle: clip.title });
            clicked.textContent = "Saved!";
            setTimeout(() => { clicked.textContent = "Download"; clicked.disabled = false; }, 2500);
          } catch (err) {
            console.error("[DOWNLOAD ERROR]", err);
            clicked.textContent = "Failed";
            alert("Download error:\n" + err);
            setTimeout(() => { clicked.textContent = "Download"; clicked.disabled = false; }, 2500);
          }
        };
      });

      grid.appendChild(card);
    }

    clipsLoaded = true;
  } catch (e) {
    grid.innerHTML = `<div class="clips-empty">Error: ${e.message}</div>`;
    console.error(e);
  }
}

/* ---------- SNACKS PAGE ---------- */
const snacksNav = document.getElementById("snacksNav");
const snacksListEl = document.getElementById("snacksList");
let snacksLoaded = false;
let snacksData = {};

// Scroll-reveal: toggles `.in-view` (see style.css) as rows cross into
// .sr-queue-col's scroll viewport (the actual scrolling element now — see
// style.css, #snacksList itself stopped being a scroll container when the
// Daily Check-In layout wrapped it), both scrolling down and back up —
// mirrors a fade+scale useInView animation, just without React/motion.
const snacksRevealObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      entry.target.classList.toggle("in-view", entry.isIntersecting);
    }
  },
  { root: snacksListEl.closest(".sr-queue-col"), threshold: 0.5 }
);

snacksNav.onclick = () => {
  setActive(snacksNav);
  showPage(snacksPage);
  if (!snacksLoaded) {
    loadSnacksPage();
    loadCheckInSettings();
  }
};

/* ---------- DAILY CHECK-IN SETTINGS (same tab/slide layout as Song Requests) ---------- */

const ciTabSettings = document.getElementById("ciTabSettings");
const ciTabQueue = document.getElementById("ciTabQueue");
const ciSlider = document.getElementById("ciSlider");
let checkInPendingRedeemId = "";

function showCheckInTab(tab) {
  const showQueue = tab === "queue";
  ciSlider.classList.toggle("show-queue", showQueue);
  ciTabSettings.classList.toggle("active", !showQueue);
  ciTabQueue.classList.toggle("active", showQueue);
}

ciTabSettings.onclick = () => showCheckInTab("settings");
ciTabQueue.onclick = () => showCheckInTab("queue");

async function loadCheckInSettings() {
  try {
    const settings = await invoke("load_list", { name: "checkInSettings" });
    document.getElementById("ciEnabled").checked = Boolean(settings.enabled);
    document.getElementById("ciPointsPerCheckIn").value = settings.pointsPerCheckIn || 1;
    document.getElementById("ciMessage").value = settings.message || "";
    checkInPendingRedeemId = settings.redeemId || "";
  } catch (err) {
    console.error(err);
  }

  loadCheckInRewards();
}

// Reuses the same Helix reward listing Song Requests/Redeems already
// implement (fetchRewardsFromTwitch, defined above) rather than
// re-fetching rewards a third time.
async function loadCheckInRewards() {
  const select = document.getElementById("ciRedeemSelect");
  select.innerHTML = '<option value="">Loading rewards…</option>';
  try {
    const rewards = await fetchRewardsFromTwitch();
    select.innerHTML =
      '<option value="">(none selected)</option>' +
      rewards.map((r) => `<option value="${r.id}">${escapeHtml(r.title)}</option>`).join("");
    select.value = checkInPendingRedeemId || "";
  } catch (e) {
    console.error("[CHECKIN] Failed to load rewards:", e);
    select.innerHTML = `<option value="">Couldn't load rewards: ${escapeHtml(e.message || String(e))}</option>`;
  }
}

document.getElementById("saveCheckInSettings").onclick = async () => {
  const btn = document.getElementById("saveCheckInSettings");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const settings = {
      enabled: document.getElementById("ciEnabled").checked,
      redeemId: document.getElementById("ciRedeemSelect").value,
      pointsPerCheckIn: parseInt(document.getElementById("ciPointsPerCheckIn").value, 10) || 1,
      message: document.getElementById("ciMessage").value.trim(),
    };
    await invoke("save_list", { name: "checkInSettings", content: settings });
    btn.textContent = "Saved!";
  } catch (e) {
    alert("Error saving Daily Check-In settings: " + e);
  } finally {
    setTimeout(() => { btn.textContent = "Save Settings"; btn.disabled = false; }, 1500);
  }
};

document.getElementById("refreshSnacks").onclick = () => loadSnacksPage();

document.getElementById("snacksSearch").oninput = (e) => {
  renderSnacks(e.target.value);
};

document.getElementById("addSnackUser").onclick = () => {
  const list = document.getElementById("snacksList");
  if (document.getElementById("snackAddRow")) return;

  const addRow = document.createElement("div");
  addRow.className = "snack-row snack-add-row";
  addRow.id = "snackAddRow";
  addRow.innerHTML = `
    <input class="snack-add-name" placeholder="username">
    <input class="snack-input" type="number" min="0" value="0">
    <div class="snack-actions">
      <button class="snack-save-btn logs-clear-btn">Add</button>
      <button class="snack-cancel-btn">Cancel</button>
    </div>
  `;
  list.prepend(addRow);
  snacksRevealObserver.observe(addRow);
  addRow.querySelector(".snack-add-name").focus();

  const doAdd = async () => {
    const username = addRow.querySelector(".snack-add-name").value.trim().toLowerCase();
    const count = parseInt(addRow.querySelector(".snack-input").value, 10);
    if (!username) return;
    snacksData[username] = isNaN(count) ? 0 : count;
    await invoke("save_list", { name: "snacks", content: snacksData });
    renderSnacks(document.getElementById("snacksSearch").value);
  };

  addRow.querySelector(".snack-save-btn").onclick = doAdd;
  addRow.querySelector(".snack-cancel-btn").onclick = () =>
    renderSnacks(document.getElementById("snacksSearch").value);
  addRow.querySelector(".snack-add-name").onkeydown = (e) => {
    if (e.key === "Enter") doAdd();
    if (e.key === "Escape") renderSnacks(document.getElementById("snacksSearch").value);
  };
};

async function loadSnacksPage() {
  const list = document.getElementById("snacksList");
  list.innerHTML = '<div class="snacks-empty">Loading…</div>';
  snacksLoaded = false;
  try {
    snacksData = await invoke("load_list", { name: "snacks" });
    renderSnacks();
    snacksLoaded = true;
  } catch (e) {
    list.innerHTML = `<div class="snacks-empty">Could not load snacks.json: ${e}</div>`;
  }
}

function renderSnacks(filter = "") {
  const list = document.getElementById("snacksList");
  const total = Object.keys(snacksData).length;
  document.getElementById("snacksCount").textContent = total;

  // Rank has to come from standing in the FULL list, not position within
  // whatever's currently filtered — otherwise the top search result gets
  // tagged #1/gold even if they're not actually the top snacker overall.
  // Ties share a rank, and the next distinct count is just the next rank
  // (dense ranking: 1, 1, 1, 2 — not 1, 1, 1, 4).
  const allSorted = Object.entries(snacksData).sort((a, b) => b[1] - a[1]);
  const rankOf = new Map();
  let rank = 0;
  let prevCount = null;
  allSorted.forEach(([user, count]) => {
    if (count !== prevCount) {
      rank += 1;
      prevCount = count;
    }
    rankOf.set(user, rank);
  });

  const entries = allSorted.filter(([user]) => !filter || user.toLowerCase().includes(filter.toLowerCase()));

  // Every render replaces the row elements wholesale, so drop whatever the
  // observer was still watching from the previous render before it's stale.
  snacksRevealObserver.disconnect();

  if (!entries.length) {
    list.innerHTML = total
      ? `<div class="snacks-empty">No matches for "${escapeHtml(filter)}"</div>`
      : '<div class="snacks-empty">No snacks recorded yet.</div>';
    return;
  }

  list.innerHTML = "";
  entries.forEach(([user, count]) => {
    const rank = rankOf.get(user);
    const row = document.createElement("div");
    row.className = "snack-row";
    if (rank <= 3) row.classList.add(`rank-${rank}`);
    row.dataset.user = user;
    row.innerHTML = `
      <span class="snack-rank">#${rank}</span>
      <span class="snack-name">${escapeHtml(user)}</span>
      <span class="snack-count">${count}</span>
      <div class="snack-actions">
        <button class="snack-edit-btn logs-clear-btn">Edit</button>
        <button class="snack-del-btn">✕</button>
      </div>
    `;

    row.querySelector(".snack-edit-btn").onclick = () => startSnackEdit(row, user, count);

    row.querySelector(".snack-del-btn").onclick = async () => {
      if (!confirm(`Remove ${user} from snacks?`)) return;
      delete snacksData[user];
      await invoke("save_list", { name: "snacks", content: snacksData });
      renderSnacks(document.getElementById("snacksSearch").value);
    };

    list.appendChild(row);
    snacksRevealObserver.observe(row);
  });
}

function startSnackEdit(row, user, currentCount) {
  const countEl = row.querySelector(".snack-count");
  const actionsEl = row.querySelector(".snack-actions");

  countEl.innerHTML = `<input class="snack-input" type="number" min="0" value="${currentCount}">`;
  actionsEl.innerHTML = `
    <button class="snack-save-btn logs-clear-btn">Save</button>
    <button class="snack-cancel-btn">Cancel</button>
  `;

  const input = countEl.querySelector("input");
  input.focus();
  input.select();

  const save = async () => {
    const val = parseInt(input.value, 10);
    if (isNaN(val) || val < 0) return;
    snacksData[user] = val;
    await invoke("save_list", { name: "snacks", content: snacksData });
    renderSnacks(document.getElementById("snacksSearch").value);
  };

  const cancel = () => renderSnacks(document.getElementById("snacksSearch").value);

  actionsEl.querySelector(".snack-save-btn").onclick = save;
  actionsEl.querySelector(".snack-cancel-btn").onclick = cancel;
  input.onkeydown = (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  };
}

/* ---------- COMMANDS PAGE ---------- */

// Static metadata for every built-in command — used both to render the
// "Built-in Commands" list and as the source of truth for collision
// checking against custom triggers. `trigger` is null for pattern-match
// commands (like !w's "wwww" match) that aren't a literal !command.
const BUILTIN_COMMANDS = [
  { key: "w", trigger: null, label: 'Repeated "w"s (e.g. "wwww")', description: "Fun pattern-match reply, not a literal !command." },
  { key: "ssnacks", trigger: "!ssnacks", description: "Looks up a user's Smoky snack count." },
  { key: "topsnacks", trigger: "!topsnacks", description: "Shows the top 3 snack counts." },
  { key: "forcereset", trigger: "!forcereset", description: "Mod/broadcaster only. Resets session shoutout tracking." },
  { key: "note", trigger: "!note", description: "Mod/VIP/broadcaster only. Posts a note to Discord." },
  { key: "time", trigger: "!time", description: "Reports the current time." },
  { key: "clip", trigger: "!clip", description: "Creates a Twitch clip." },
  { key: "repeat", trigger: "!repeat", description: "Mod/broadcaster only. Repeats the bot's last message." },
  { key: "shoutout", trigger: "!so", description: "Mod/broadcaster only. Triggers an official Twitch shoutout." },
  { key: "coinPause", trigger: "!p", description: "Mod/broadcaster only. Pauses/resumes the coin toss game." },
  { key: "coin", trigger: "!coin", description: "Responds to an active coin toss challenge." },
  { key: "songRequest", trigger: null, label: "!sr (configurable in Song Requests)", description: "Requests a song via chat, if enabled." },
  { key: "removeRequest", trigger: "!remove", description: "Removes a pending song request, yours, or anyone's if you're a mod." },
  { key: "song", trigger: "!song", description: "Shows the currently playing song, and who requested it if it was a request." },
  { key: "queue", trigger: "!queue", description: "Shows upcoming songs. !queue N shows N instead of the configured default." },
  { key: "next", trigger: "!next", description: "Shows the very next upcoming song." },
];

const PERMISSION_LABELS = {
  everyone: "Everyone",
  subscriber: "Sub",
  subscriberT2: "T2 Sub+",
  subscriberT3: "T3 Sub+",
  moderator: "Mod",
  broadcaster: "Broadcaster",
};

// "vip"/"broadcaster" only ever appear here for commands saved before the
// old single-select ladder was replaced by these OR-matched checkboxes —
// mirrors the same fallback in bot/commands/customCommands.js so the UI and
// the bot agree on what an unmigrated command actually means.
const LEGACY_PERMISSION_MAP = {
  everyone: ["everyone"],
  subscriber: ["subscriber"],
  subscriberT2: ["subscriberT2"],
  subscriberT3: ["subscriberT3"],
  vip: ["moderator"],
  moderator: ["moderator"],
  broadcaster: [],
};

function normalizePermissions(cmd) {
  if (Array.isArray(cmd.permissions)) return cmd.permissions;
  if (cmd.permission) return LEGACY_PERMISSION_MAP[cmd.permission] || ["everyone"];
  return ["everyone"];
}

function permissionSummaryLabel(cmd) {
  const perms = normalizePermissions(cmd);
  if (perms.length === 0) return "Broadcaster only";
  if (perms.includes("everyone")) return "Everyone";
  return perms.map((p) => PERMISSION_LABELS[p] || p).join(" / ");
}

const commandsNav = document.getElementById("commandsNav");
let customCommandsData = [];
let catalogData = {};
let messageOverridesData = {};
let editingCommandId = null;

commandsNav.onclick = () => {
  setActive(commandsNav);
  showPage(commandsPage);
  loadCommandsPage();
};

async function loadCommandsPage() {
  const [cmdsRes, catalogRes, overridesRes] = await Promise.allSettled([
    invoke("load_list", { name: "customCommands" }),
    invoke("load_list", { name: "commandMessageCatalog" }),
    invoke("load_list", { name: "commandMessages" }),
  ]);

  customCommandsData = cmdsRes.status === "fulfilled" ? cmdsRes.value.commands || [] : [];
  catalogData = catalogRes.status === "fulfilled" ? catalogRes.value || {} : {};
  messageOverridesData = overridesRes.status === "fulfilled" ? overridesRes.value || {} : {};

  if (cmdsRes.status === "rejected") console.error("[COMMANDS] Failed to load customCommands:", cmdsRes.reason);
  if (catalogRes.status === "rejected") console.error("[COMMANDS] Failed to load catalog:", catalogRes.reason);
  if (overridesRes.status === "rejected") console.error("[COMMANDS] Failed to load overrides:", overridesRes.reason);

  renderCustomCommandsList();
  renderBuiltinCommandsList();
}

async function saveCustomCommands() {
  await invoke("save_list", { name: "customCommands", content: { commands: customCommandsData } });
}

function formatCooldown(cooldown) {
  if (!cooldown || cooldown.mode === "none" || !cooldown.seconds) return "";
  return `${cooldown.seconds}s ${cooldown.mode === "peruser" ? "per-user" : "global"}`;
}

function commandSummary(cmd) {
  if (cmd.type === "counter") {
    const actionLabel =
      cmd.action === "increment" ? "adds to" : cmd.action === "decrement" ? "subtracts from" : "shows";
    return `${actionLabel} counter "${cmd.counter || "?"}"`;
  }
  const first = (cmd.replies && cmd.replies[0]) || "";
  return cmd.replies && cmd.replies.length > 1 ? `${first} (+${cmd.replies.length - 1} more)` : first;
}

function renderCustomCommandsList() {
  const list = document.getElementById("customCommandsList");
  document.getElementById("customCommandsCount").textContent = customCommandsData.length;

  if (!customCommandsData.length) {
    list.innerHTML = '<div class="commands-empty">No custom commands yet. Click "+ New Command" to add one.</div>';
    return;
  }

  list.innerHTML = "";
  customCommandsData.forEach((cmd) => {
    const card = document.createElement("div");
    card.className = "command-card";

    const typeLabel = cmd.type === "counter" ? "Counter" : "Reply";
    const permLabel = permissionSummaryLabel(cmd);
    const cooldownLabel = formatCooldown(cmd.cooldown);
    const enabled = cmd.enabled !== false;

    card.innerHTML = `
      <div class="command-card-row">
        <span class="command-trigger">${escapeHtml(cmd.trigger)}</span>
        <span class="command-description">${escapeHtml(commandSummary(cmd))}</span>
        <span class="cmd-badge">${typeLabel}</span>
        <span class="cmd-badge muted">${permLabel}</span>
        ${cooldownLabel ? `<span class="cmd-badge muted">${escapeHtml(cooldownLabel)}</span>` : ""}
        ${cmd.sfxFile ? `<span class="cmd-badge muted">🔊 ${escapeHtml(cmd.sfxFile)}</span>` : ""}
        <label class="cmd-toggle" title="${enabled ? "Enabled" : "Disabled"}">
          <input type="checkbox" ${enabled ? "checked" : ""}>
          <span class="cmd-toggle-track"></span>
        </label>
        <div class="cmd-actions">
          <button type="button" class="command-edit-btn">Edit</button>
          <button type="button" class="command-del-btn">✕</button>
        </div>
      </div>
    `;

    card.querySelector(".cmd-toggle input").onchange = async (e) => {
      cmd.enabled = e.target.checked;
      await saveCustomCommands();
    };

    card.querySelector(".command-edit-btn").onclick = () => openCommandForm(cmd);

    card.querySelector(".command-del-btn").onclick = async () => {
      if (!confirm(`Delete ${cmd.trigger}?`)) return;
      customCommandsData = customCommandsData.filter((c) => c.id !== cmd.id);
      await saveCustomCommands();
      renderCustomCommandsList();
    };

    list.appendChild(card);
  });
}

function renderBuiltinCommandsList() {
  const list = document.getElementById("builtinCommandsList");
  list.innerHTML = "";

  BUILTIN_COMMANDS.forEach((info) => {
    const messages = catalogData[info.key];
    const card = document.createElement("div");
    card.className = "command-card builtin";

    card.innerHTML = `
      <div class="command-card-row">
        <span class="command-trigger">${escapeHtml(info.trigger || info.label)}</span>
        <span class="command-description">${escapeHtml(info.description)}</span>
        ${messages ? '<button type="button" class="builtin-expand-btn">Edit messages</button>' : ""}
      </div>
      ${messages ? '<div class="builtin-messages"></div>' : ""}
    `;

    if (messages) {
      const expandBtn = card.querySelector(".builtin-expand-btn");
      const panel = card.querySelector(".builtin-messages");

      expandBtn.onclick = () => {
        const opening = !panel.classList.contains("open");
        panel.classList.toggle("open");
        expandBtn.textContent = opening ? "Hide messages" : "Edit messages";
        if (opening && !panel.dataset.rendered) {
          renderBuiltinMessageFields(panel, info.key, messages);
          panel.dataset.rendered = "1";
        }
      };
    }

    list.appendChild(card);
  });
}

function renderBuiltinMessageFields(panel, key, messages) {
  const overridesForKey = messageOverridesData[key] || {};

  const fieldsHtml = Object.entries(messages)
    .map(([msgKey, meta]) => {
      const currentValue = overridesForKey[msgKey] ?? meta.default;
      const namedPlaceholders = meta.placeholders && meta.placeholders.length ? meta.placeholders.map((p) => `{${p}}`).join(", ") + ", " : "";
      const placeholderHint = `Placeholders: ${namedPlaceholders}{random:1-100}, {choice:a|b|c}`;
      return `
        <div class="builtin-message-field" data-message-key="${escapeHtml(msgKey)}">
          <label>${escapeHtml(meta.description)}</label>
          <textarea>${escapeHtml(currentValue)}</textarea>
          <span class="field-hint">${escapeHtml(placeholderHint)}</span>
        </div>
      `;
    })
    .join("");

  panel.innerHTML = `
    ${fieldsHtml}
    <div class="builtin-messages-actions">
      <button type="button" class="toggle-vis" data-action="reset">Reset to defaults</button>
      <button type="button" class="primary" data-action="save">Save</button>
    </div>
  `;

  panel.querySelector('[data-action="save"]').onclick = async () => {
    const updated = {};
    panel.querySelectorAll(".builtin-message-field").forEach((field) => {
      updated[field.dataset.messageKey] = field.querySelector("textarea").value;
    });
    messageOverridesData[key] = updated;
    await invoke("save_list", { name: "commandMessages", content: messageOverridesData });

    const btn = panel.querySelector('[data-action="save"]');
    btn.textContent = "Saved!";
    setTimeout(() => {
      btn.textContent = "Save";
    }, 1500);
  };

  panel.querySelector('[data-action="reset"]').onclick = async () => {
    delete messageOverridesData[key];
    await invoke("save_list", { name: "commandMessages", content: messageOverridesData });
    panel.dataset.rendered = "";
    renderBuiltinMessageFields(panel, key, messages);
  };
}

/* ---------- Placeholder reference ---------- */

const UNIVERSAL_PLACEHOLDERS = [
  { name: "random:min-max", description: "A random whole number in that range, e.g. {random:1-100}." },
  { name: "choice:a|b|c", description: "Randomly picks one of the given options, e.g. {choice:yes|no|maybe}." },
];

const CUSTOM_COMMAND_PLACEHOLDERS = [
  { name: "user", description: "The chatter who used the command." },
  { name: "channel", description: "Your channel name." },
  { name: "args", description: "Whatever text was typed after the command." },
  { name: "value", description: "The counter's current value (counter commands only)." },
];

const REDEEM_PLACEHOLDERS = [
  { name: "user", description: "The viewer who redeemed it." },
  { name: "channel", description: "Your channel name." },
  { name: "input", description: "The text they entered, if the redeem requires input." },
  { name: "value", description: "The counter's current value (Counter redeems only)." },
];

function placeholderRow(name, description) {
  return `<div class="placeholder-row"><code>{${escapeHtml(name)}}</code><span>${escapeHtml(description)}</span></div>`;
}

function uniquePlaceholdersForCatalogEntry(messages) {
  const set = new Set();
  Object.values(messages).forEach((meta) => (meta.placeholders || []).forEach((p) => set.add(p)));
  return Array.from(set);
}

function renderPlaceholderHelp() {
  const body = document.getElementById("placeholderHelpBody");

  const universalRows = UNIVERSAL_PLACEHOLDERS.map((p) => placeholderRow(p.name, p.description)).join("");
  const customRows = CUSTOM_COMMAND_PLACEHOLDERS.map((p) => placeholderRow(p.name, p.description)).join("");
  const redeemRows = REDEEM_PLACEHOLDERS.map((p) => placeholderRow(p.name, p.description)).join("");

  const builtinRows = Object.entries(catalogData)
    .map(([key, messages]) => {
      const info = BUILTIN_COMMANDS.find((c) => c.key === key);
      const label = info ? info.trigger || info.label : key;
      const placeholders = uniquePlaceholdersForCatalogEntry(messages);
      if (!placeholders.length) return "";

      const placeholderList = placeholders.map((p) => `{${escapeHtml(p)}}`).join(", ");
      return `<div class="placeholder-row"><code>${escapeHtml(label)}</code><span>${placeholderList}</span></div>`;
    })
    .join("");

  body.innerHTML = `
    <div class="placeholder-group">
      <h4>Everywhere</h4>
      ${universalRows}
    </div>
    <div class="placeholder-group">
      <h4>Custom Commands</h4>
      ${customRows}
    </div>
    <div class="placeholder-group">
      <h4>Redeems</h4>
      ${redeemRows}
    </div>
    <div class="placeholder-group-divider">Built-in Command Messages</div>
    <div class="placeholder-group">
      ${builtinRows || '<span class="field-hint">Open a built-in command\'s message editor at least once to populate this.</span>'}
    </div>
  `;
}

function openPlaceholderHelp() {
  renderPlaceholderHelp();
  document.getElementById("placeholderHelpOverlay").classList.add("open");
}

function closePlaceholderHelp() {
  document.getElementById("placeholderHelpOverlay").classList.remove("open");
}

document.getElementById("placeholderHelpBtn").onclick = openPlaceholderHelp;
document.getElementById("cmdFormHelpBtn").onclick = openPlaceholderHelp;
document.getElementById("placeholderHelpClose").onclick = closePlaceholderHelp;

document.getElementById("placeholderHelpOverlay").addEventListener("click", (e) => {
  if (e.target.id === "placeholderHelpOverlay") closePlaceholderHelp();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("placeholderHelpOverlay").classList.contains("open")) {
    closePlaceholderHelp();
  }
});

// Shared by the Commands and Redeems cooldown fields — a segmented-button
// toggle (same visual language as the type/action toggles elsewhere in
// these forms) standing in for what used to be a native <select>. A hidden
// input still holds the actual mode string so the rest of each form's code
// can keep reading `.value` unchanged.
function setCooldownMode(containerId, hiddenInputId, secondsInputId, mode) {
  const container = document.getElementById(containerId);
  const hiddenInput = document.getElementById(hiddenInputId);
  const secondsInput = document.getElementById(secondsInputId);

  hiddenInput.value = mode;
  container.querySelectorAll(".cooldown-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  });
  secondsInput.style.display = mode === "none" ? "none" : "";
}

function initCooldownToggle(containerId, hiddenInputId, secondsInputId, onAfterChange) {
  const container = document.getElementById(containerId);
  container.querySelectorAll(".cooldown-mode-btn").forEach((btn) => {
    btn.onclick = () => {
      setCooldownMode(containerId, hiddenInputId, secondsInputId, btn.dataset.mode);
      if (onAfterChange) onAfterChange();
    };
  });
}

/* ---------- Command create/edit modal ---------- */

const commandFormOverlay = document.getElementById("commandFormOverlay");
const commandFormTitle = document.getElementById("commandFormTitle");
const cmdTriggerInput = document.getElementById("cmdTrigger");
const cmdTriggerError = document.getElementById("cmdTriggerError");
const cmdRepliesList = document.getElementById("cmdRepliesList");
const cmdReplyFields = document.getElementById("cmdReplyFields");
const cmdCounterFields = document.getElementById("cmdCounterFields");
const cmdCounterName = document.getElementById("cmdCounterName");
const cmdCounterAction = document.getElementById("cmdCounterAction");
const cmdCounterStepField = document.getElementById("cmdCounterStepField");
const cmdCounterStep = document.getElementById("cmdCounterStep");
const cmdCounterTemplate = document.getElementById("cmdCounterTemplate");
const cmdSfxEnabled = document.getElementById("cmdSfxEnabled");
const cmdSfxFields = document.getElementById("cmdSfxFields");
const cmdSfxFile = document.getElementById("cmdSfxFile");
const cmdPermissionChecks = document.getElementById("cmdPermissionChecks");
const cmdCooldownMode = document.getElementById("cmdCooldownMode");
const cmdCooldownSeconds = document.getElementById("cmdCooldownSeconds");

let currentCommandType = "reply";
let pendingCmdSfxPath = null; // absolute path of a freshly-picked file, staged until save

function getCheckedPermissions() {
  return Array.from(cmdPermissionChecks.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => cb.value);
}

function setCheckedPermissions(perms) {
  cmdPermissionChecks.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = perms.includes(cb.value);
  });
}

// "Everyone" makes every other option redundant, and vice versa — keep
// them mutually exclusive so the checked state can't silently imply
// something false (e.g. "Everyone + Moderator" looking more restrictive
// than it actually is).
cmdPermissionChecks.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
  cb.onchange = () => {
    const all = cmdPermissionChecks.querySelectorAll('input[type="checkbox"]');
    if (cb.value === "everyone" && cb.checked) {
      all.forEach((other) => { if (other !== cb) other.checked = false; });
    } else if (cb.checked) {
      const everyoneBox = cmdPermissionChecks.querySelector('input[value="everyone"]');
      if (everyoneBox) everyoneBox.checked = false;
    }
  };
});

function addReplyRow(value = "") {
  const row = document.createElement("div");
  row.className = "cmd-reply-row";
  row.innerHTML = `
    <input type="text" value="${escapeHtml(value)}" placeholder="Reply text...">
    <button type="button" class="cmd-reply-remove" title="Remove">✕</button>
  `;
  row.querySelector(".cmd-reply-remove").onclick = () => {
    if (cmdRepliesList.children.length > 1) row.remove();
  };
  cmdRepliesList.appendChild(row);
}

document.getElementById("addReplyVariant").onclick = () => addReplyRow();

document.querySelectorAll(".cmd-type-btn").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".cmd-type-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentCommandType = btn.dataset.type;
    cmdReplyFields.style.display = currentCommandType === "reply" ? "" : "none";
    cmdCounterFields.style.display = currentCommandType === "counter" ? "" : "none";
  };
});

cmdCounterAction.onchange = () => {
  cmdCounterStepField.style.display = cmdCounterAction.value === "view" ? "none" : "";
};

cmdSfxEnabled.onchange = () => {
  cmdSfxFields.style.display = cmdSfxEnabled.checked ? "" : "none";
};

document.getElementById("chooseCmdSfxFile").onclick = () => {
  pickSfxFile(cmdSfxFile, (path) => { pendingCmdSfxPath = path; });
};

initCooldownToggle("cmdCooldownToggle", "cmdCooldownMode", "cmdCooldownSeconds");

function refreshCounterNameSuggestions() {
  const datalist = document.getElementById("counterNamesList");
  const names = new Set(customCommandsData.filter((c) => c.type === "counter" && c.counter).map((c) => c.counter));
  datalist.innerHTML = Array.from(names)
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

function generateCommandId() {
  return `cmd_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function openCommandForm(existingCmd = null) {
  editingCommandId = existingCmd ? existingCmd.id : null;
  commandFormTitle.textContent = existingCmd ? `Edit ${existingCmd.trigger}` : "New Command";
  cmdTriggerError.classList.remove("visible");
  cmdTriggerError.innerHTML = "";

  cmdTriggerInput.value = existingCmd ? existingCmd.trigger : "";
  currentCommandType = existingCmd ? existingCmd.type || "reply" : "reply";

  document.querySelectorAll(".cmd-type-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.type === currentCommandType);
  });
  cmdReplyFields.style.display = currentCommandType === "reply" ? "" : "none";
  cmdCounterFields.style.display = currentCommandType === "counter" ? "" : "none";

  cmdRepliesList.innerHTML = "";
  if (currentCommandType === "reply") {
    const replies = existingCmd && existingCmd.replies && existingCmd.replies.length ? existingCmd.replies : [""];
    replies.forEach((r) => addReplyRow(r));
  } else {
    addReplyRow("");
  }

  refreshCounterNameSuggestions();
  cmdCounterName.value = existingCmd ? existingCmd.counter || "" : "";
  cmdCounterAction.value = existingCmd ? existingCmd.action || "view" : "view";
  cmdCounterStepField.style.display = cmdCounterAction.value === "view" ? "none" : "";
  cmdCounterStep.value = existingCmd ? existingCmd.step || 1 : 1;
  cmdCounterTemplate.value = existingCmd ? existingCmd.template || "" : "";

  setCheckedPermissions(existingCmd ? normalizePermissions(existingCmd) : ["everyone"]);
  cmdCooldownSeconds.value = existingCmd?.cooldown?.seconds || 10;
  setCooldownMode("cmdCooldownToggle", "cmdCooldownMode", "cmdCooldownSeconds", existingCmd?.cooldown?.mode || "none");

  cmdSfxEnabled.checked = Boolean(existingCmd?.sfxFile);
  cmdSfxFields.style.display = cmdSfxEnabled.checked ? "" : "none";
  pendingCmdSfxPath = null;
  cmdSfxFile.value = existingCmd?.sfxFile || "";

  commandFormOverlay.classList.add("open");
  cmdTriggerInput.focus();
}

function closeCommandForm() {
  commandFormOverlay.classList.remove("open");
  editingCommandId = null;
}

document.getElementById("addCustomCommand").onclick = () => openCommandForm(null);
document.getElementById("commandFormClose").onclick = closeCommandForm;
document.getElementById("commandFormCancel").onclick = closeCommandForm;

commandFormOverlay.addEventListener("click", (e) => {
  if (e.target === commandFormOverlay) closeCommandForm();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && commandFormOverlay.classList.contains("open")) closeCommandForm();
});

function findBuiltinCollision(trigger) {
  return BUILTIN_COMMANDS.find((c) => c.trigger && c.trigger.toLowerCase() === trigger.toLowerCase());
}

function findCustomCollision(trigger, excludeId) {
  return customCommandsData.find((c) => c.id !== excludeId && c.trigger.toLowerCase() === trigger.toLowerCase());
}

function showTriggerError(html) {
  cmdTriggerError.innerHTML = html;
  cmdTriggerError.classList.add("visible");
}

document.getElementById("commandFormSave").onclick = async () => {
  const rawTrigger = cmdTriggerInput.value.trim();
  cmdTriggerError.classList.remove("visible");
  cmdTriggerError.innerHTML = "";

  if (!rawTrigger) {
    showTriggerError("Trigger can't be empty.");
    return;
  }

  const trigger = rawTrigger.startsWith("!") ? rawTrigger : `!${rawTrigger}`;

  if (/\s/.test(trigger)) {
    showTriggerError("Trigger can't contain spaces.");
    return;
  }

  const builtinHit = findBuiltinCollision(trigger);
  if (builtinHit) {
    showTriggerError(
      `"${escapeHtml(trigger)}" is already a built-in command. <a id="collisionGoBuiltin">See it under Built-in Commands</a>.`
    );
    document.getElementById("collisionGoBuiltin").onclick = () => {
      closeCommandForm();
      document.querySelector(".commands-section-divider")?.scrollIntoView({ behavior: "smooth" });
    };
    return;
  }

  const customHit = findCustomCollision(trigger, editingCommandId);
  if (customHit) {
    showTriggerError(
      `"${escapeHtml(trigger)}" is already used by another custom command. <a id="collisionGoEdit">Edit that command instead</a>.`
    );
    document.getElementById("collisionGoEdit").onclick = () => openCommandForm(customHit);
    return;
  }

  if (currentCommandType === "counter" && !cmdCounterName.value.trim()) {
    showTriggerError("Counter commands need a counter name.");
    return;
  }

  if (cmdSfxEnabled.checked && !cmdSfxFile.value) {
    showTriggerError("Pick a sound file for this command.");
    return;
  }

  if (getCheckedPermissions().length === 0) {
    showTriggerError("Pick at least one option for who can use this command.");
    return;
  }

  const cooldownMode = cmdCooldownMode.value;
  const cooldown = {
    mode: cooldownMode,
    seconds: cooldownMode === "none" ? 0 : parseInt(cmdCooldownSeconds.value, 10) || 0,
  };

  let cmd = editingCommandId ? customCommandsData.find((c) => c.id === editingCommandId) : null;
  if (!cmd) {
    cmd = { id: generateCommandId(), enabled: true };
    customCommandsData.push(cmd);
  }

  cmd.trigger = trigger;
  cmd.type = currentCommandType;
  cmd.permissions = getCheckedPermissions();
  delete cmd.permission;
  cmd.cooldown = cooldown;

  if (currentCommandType === "counter") {
    cmd.counter = cmdCounterName.value.trim();
    cmd.action = cmdCounterAction.value;
    cmd.step = parseInt(cmdCounterStep.value, 10) || 1;
    cmd.template = cmdCounterTemplate.value.trim() || "{value}";
    delete cmd.replies;
  } else {
    const replies = Array.from(cmdRepliesList.querySelectorAll("input"))
      .map((input) => input.value.trim())
      .filter(Boolean);
    cmd.replies = replies.length ? replies : [""];
    delete cmd.counter;
    delete cmd.action;
    delete cmd.step;
    delete cmd.template;
  }

  if (cmdSfxEnabled.checked) {
    // A freshly-picked file still needs copying into sfx/ — an unchanged
    // one (editing without touching the picker) is already in there.
    cmd.sfxFile = pendingCmdSfxPath
      ? await invoke("import_sfx_file", { sourcePath: pendingCmdSfxPath })
      : cmdSfxFile.value;
  } else {
    delete cmd.sfxFile;
  }

  await saveCustomCommands();
  closeCommandForm();
  renderCustomCommandsList();
};

/* ---------- REDEEMS PAGE ---------- */

const redeemsNav = document.getElementById("redeemsNav");
let redeemsData = []; // live Twitch rewards, each annotated with .manageable
let redeemConfigs = {}; // local action/constraint config, keyed by Twitch reward id
let editingReward = null; // the live reward object being edited, or null for "new"
let currentRedeemAction = "message";
let pendingRedeemSfxPath = null; // absolute path of a freshly-picked file, staged until save

redeemsNav.onclick = () => {
  setActive(redeemsNav);
  showPage(redeemsPage);
  loadRedeemsPage();
};

// Shared by list-fetching and the save/delete flows below — resolves the
// streamer's Helix auth headers + broadcaster id the same way the Clips
// page already does for the mod token.
async function getStreamerHelixContext() {
  const env = await invoke("load_env");
  const token = env.STREAMER_USER_ACCESS_TOKEN;
  const clientId = env.TWITCH_CLIENT_ID;
  const broadcasterLogin = env.TARGET_CHANNEL_LOGIN;

  if (!token || !clientId || !broadcasterLogin) {
    throw new Error("Missing TWITCH_CLIENT_ID, STREAMER_USER_ACCESS_TOKEN, or TARGET_CHANNEL_LOGIN in config.");
  }

  const headers = { Authorization: `Bearer ${token}`, "Client-Id": clientId };
  const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${broadcasterLogin}`, { headers });
  const userData = await userRes.json();
  const broadcasterId = userData.data?.[0]?.id;
  if (!broadcasterId) throw new Error("Could not resolve broadcaster ID, check your streamer token.");

  return { headers, broadcasterId };
}

async function fetchRewardsFromTwitch() {
  const { headers, broadcasterId } = await getStreamerHelixContext();

  const [allRes, manageableRes] = await Promise.all([
    fetch(`https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`, { headers }),
    fetch(
      `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&only_manageable_rewards=true`,
      { headers }
    ),
  ]);

  if (!allRes.ok) {
    const errBody = await allRes.json().catch(() => ({}));
    throw new Error(
      errBody.message || `Twitch returned ${allRes.status}. Your streamer token likely needs the channel:manage:redemptions scope.`
    );
  }

  const allData = await allRes.json();
  const manageableData = manageableRes.ok ? await manageableRes.json() : { data: [] };
  const manageableIds = new Set((manageableData.data || []).map((r) => r.id));

  return (allData.data || []).map((r) => ({ ...r, manageable: manageableIds.has(r.id) }));
}

async function loadRedeemsPage() {
  const list = document.getElementById("redeemsList");
  list.innerHTML = '<div class="commands-empty">Loading redeems…</div>';

  const [rewardsResult, configResult] = await Promise.allSettled([
    fetchRewardsFromTwitch(),
    invoke("load_list", { name: "redeems" }),
  ]);

  redeemConfigs = configResult.status === "fulfilled" ? configResult.value || {} : {};

  if (rewardsResult.status === "rejected") {
    console.error("[REDEEMS] Failed to load rewards:", rewardsResult.reason);
    list.innerHTML = `<div class="commands-empty">Couldn't load redeems from Twitch: ${escapeHtml(
      String(rewardsResult.reason.message || rewardsResult.reason)
    )}</div>`;
    document.getElementById("redeemsCount").textContent = "0";
    return;
  }

  redeemsData = rewardsResult.value;
  renderRedeemsList();
}

function redeemActionLabel(cfg) {
  if (!cfg) return "No bot action configured";
  if (cfg.action === "counter") return `Counter: ${cfg.counter || "?"}`;
  if (cfg.action === "snackCheckin") return "Snack Check-in";
  if (cfg.action === "sfx") return `Sound: ${cfg.sfxFile || "?"}`;
  return "Message";
}

// Shared by the Redeems and Commands sfx pickers. Opens a native file
// dialog (audio files only); if the user picks one, shows its bare
// filename in the readonly display input and hands the full source path
// to the caller, who stashes it until save time (that's when the actual
// copy into sfx/ happens, via import_sfx_file).
async function pickSfxFile(displayInput, onPicked) {
  const path = await invoke("pick_sfx_file");
  if (!path) return;
  displayInput.value = path.split(/[\\/]/).pop();
  onPicked(path);
}

function redeemTierLabel(cfg) {
  const tiers = normalizeMinSubTiers(cfg).filter((t) => t > 0);
  if (tiers.length === 0) return null;

  // OR-matched checkboxes ("T1+" or "T3 only" checked together, say) means
  // the lowest checked threshold is the one that actually governs.
  const lowest = Math.min(...tiers);
  if (lowest >= 3000) return "Tier 3+";
  if (lowest >= 2000) return "Tier 2+";
  return "Tier 1+";
}

function renderRedeemsList() {
  const list = document.getElementById("redeemsList");
  document.getElementById("redeemsCount").textContent = redeemsData.length;

  if (!redeemsData.length) {
    list.innerHTML = '<div class="commands-empty">No Channel Points rewards yet. Click "+ New Redeem" to add one.</div>';
    return;
  }

  list.innerHTML = "";
  redeemsData.forEach((reward) => {
    const cfg = redeemConfigs[reward.id];
    const card = document.createElement("div");
    card.className = "command-card" + (reward.is_enabled === false ? " redeem-disabled" : "");

    const tierLabel = redeemTierLabel(cfg);
    const cooldownLabel = formatCooldown(cfg?.cooldown);
    const skipQueueRisk =
      reward.should_redemptions_skip_request_queue && cfg && (cfg.minSubTier || cfg.cooldown?.mode !== "none");

    card.innerHTML = `
      <div class="command-card-row">
        <span class="command-trigger">${escapeHtml(reward.title)}</span>
        <span class="redeem-cost-badge">${reward.cost} pts</span>
        <span class="command-description">${escapeHtml(redeemActionLabel(cfg))}</span>
        ${tierLabel ? `<span class="cmd-badge">${tierLabel}</span>` : ""}
        ${cooldownLabel ? `<span class="cmd-badge muted">${escapeHtml(cooldownLabel)}</span>` : ""}
        ${!reward.manageable ? '<span class="cmd-badge muted">Dashboard-made</span>' : ""}
        <div class="cmd-actions">
          <button type="button" class="command-edit-btn">Edit</button>
        </div>
      </div>
      ${
        skipQueueRisk
          ? '<div class="redeem-warning-banner">⚠ Skip Reward Queue is on. The constraints above can\'t actually be enforced for this redeem.</div>'
          : ""
      }
    `;

    card.querySelector(".command-edit-btn").onclick = () => openRedeemForm(reward);

    list.appendChild(card);
  });
}

/* ---------- Redeem create/edit modal ---------- */

const redeemFormOverlay = document.getElementById("redeemFormOverlay");
const redeemFormTitle = document.getElementById("redeemFormTitle");
const redeemManageableNotice = document.getElementById("redeemManageableNotice");
const redeemTitleInput = document.getElementById("redeemTitle");
const redeemCostInput = document.getElementById("redeemCost");
const redeemPromptInput = document.getElementById("redeemPrompt");
const redeemRequireInput = document.getElementById("redeemRequireInput");
const redeemColorInput = document.getElementById("redeemColor");
const redeemColorTrigger = document.getElementById("redeemColorTrigger");
const redeemColorSwatch = document.getElementById("redeemColorSwatch");
const redeemColorHexLabel = document.getElementById("redeemColorHexLabel");

function setRedeemColorDisplay(hex) {
  redeemColorInput.value = hex;
  redeemColorSwatch.style.background = hex;
  redeemColorHexLabel.textContent = hex.toUpperCase();
}

redeemColorTrigger.onclick = (e) => {
  e.stopPropagation();
  toggleColorPopover(redeemColorTrigger, redeemColorInput.value || "#8b5cf6", setRedeemColorDisplay);
};
const redeemEnabledOnTwitch = document.getElementById("redeemEnabledOnTwitch");
const redeemSkipQueue = document.getElementById("redeemSkipQueue");
const redeemSkipQueueWarning = document.getElementById("redeemSkipQueueWarning");
const redeemRepliesList = document.getElementById("redeemRepliesList");
const redeemMessageFields = document.getElementById("redeemMessageFields");
const redeemCounterFields = document.getElementById("redeemCounterFields");
const redeemSnackFields = document.getElementById("redeemSnackFields");
const redeemSfxFields = document.getElementById("redeemSfxFields");
const redeemSfxFile = document.getElementById("redeemSfxFile");
const redeemCounterName = document.getElementById("redeemCounterName");
const redeemCounterAction = document.getElementById("redeemCounterAction");
const redeemCounterStepField = document.getElementById("redeemCounterStepField");
const redeemCounterStep = document.getElementById("redeemCounterStep");
const redeemCounterTemplate = document.getElementById("redeemCounterTemplate");
const redeemSnackAmount = document.getElementById("redeemSnackAmount");
const redeemSnackTemplate = document.getElementById("redeemSnackTemplate");
const redeemMinTierChecks = document.getElementById("redeemMinTierChecks");
const redeemCooldownMode = document.getElementById("redeemCooldownMode");
const redeemCooldownSeconds = document.getElementById("redeemCooldownSeconds");
const redeemSfxQueueNote = document.getElementById("redeemSfxQueueNote");
const redeemConfigEnabled = document.getElementById("redeemConfigEnabled");

function getCheckedMinTiers() {
  return Array.from(redeemMinTierChecks.querySelectorAll('input[type="checkbox"]:checked')).map((cb) => parseInt(cb.value, 10));
}

function setCheckedMinTiers(tiers) {
  redeemMinTierChecks.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = tiers.includes(parseInt(cb.value, 10));
  });
}

// Same "Everyone" mutual-exclusivity as the Commands permission checks —
// picking Everyone makes any tier requirement meaningless, and vice versa.
redeemMinTierChecks.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
  cb.onchange = () => {
    const all = redeemMinTierChecks.querySelectorAll('input[type="checkbox"]');
    if (cb.value === "0" && cb.checked) {
      all.forEach((other) => { if (other !== cb) other.checked = false; });
    } else if (cb.checked) {
      const everyoneBox = redeemMinTierChecks.querySelector('input[value="0"]');
      if (everyoneBox) everyoneBox.checked = false;
    }
    updateSkipQueueWarningVisibility();
  };
});

// cfg.minSubTiers is the current shape (array of checked 0/1000/2000/3000
// values); cfg.minSubTier (singular) is the old single-select dropdown's
// shape, still read here so redeems from before this change display
// correctly until they're next saved.
function normalizeMinSubTiers(cfg) {
  if (Array.isArray(cfg?.minSubTiers)) return cfg.minSubTiers;
  if (typeof cfg?.minSubTier === "number") return [cfg.minSubTier];
  return [0];
}

function addRedeemReplyRow(value = "") {
  const row = document.createElement("div");
  row.className = "cmd-reply-row";
  row.innerHTML = `
    <input type="text" value="${escapeHtml(value)}" placeholder="Reply text...">
    <button type="button" class="cmd-reply-remove" title="Remove">✕</button>
  `;
  row.querySelector(".cmd-reply-remove").onclick = () => {
    if (redeemRepliesList.children.length > 1) row.remove();
  };
  redeemRepliesList.appendChild(row);
}

document.getElementById("addRedeemReplyVariant").onclick = () => addRedeemReplyRow();

document.querySelectorAll(".redeem-action-btn").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".redeem-action-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentRedeemAction = btn.dataset.action;
    redeemMessageFields.style.display = currentRedeemAction === "message" ? "" : "none";
    redeemCounterFields.style.display = currentRedeemAction === "counter" ? "" : "none";
    redeemSnackFields.style.display = currentRedeemAction === "snackCheckin" ? "" : "none";
    redeemSfxFields.style.display = currentRedeemAction === "sfx" ? "" : "none";
    redeemSfxQueueNote.style.display = currentRedeemAction === "sfx" ? "" : "none";
  };
});

document.getElementById("chooseRedeemSfxFile").onclick = () => {
  pickSfxFile(redeemSfxFile, (path) => { pendingRedeemSfxPath = path; });
};

redeemCounterAction.onchange = () => {
  redeemCounterStepField.style.display = redeemCounterAction.value === "view" ? "none" : "";
};

initCooldownToggle("redeemCooldownToggle", "redeemCooldownMode", "redeemCooldownSeconds", () => updateSkipQueueWarningVisibility());

function updateSkipQueueWarningVisibility() {
  const hasConstraints = getCheckedMinTiers().some((t) => t > 0) || redeemCooldownMode.value !== "none";
  redeemSkipQueueWarning.classList.toggle("visible", redeemSkipQueue.checked && hasConstraints);
}
redeemSkipQueue.onchange = updateSkipQueueWarningVisibility;

function refreshRedeemCounterSuggestions() {
  const datalist = document.getElementById("redeemCounterNamesList");
  const names = new Set([
    ...customCommandsData.filter((c) => c.type === "counter" && c.counter).map((c) => c.counter),
    ...Object.values(redeemConfigs)
      .filter((c) => c.action === "counter" && c.counter)
      .map((c) => c.counter),
  ]);
  datalist.innerHTML = Array.from(names)
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

function openRedeemForm(reward = null) {
  editingReward = reward;
  const cfg = reward ? redeemConfigs[reward.id] : null;

  redeemFormTitle.textContent = reward ? `Edit ${reward.title}` : "New Redeem";
  document.getElementById("redeemFormDelete").style.display = reward ? "" : "none";

  const manageable = !reward || reward.manageable;
  redeemManageableNotice.style.display = reward && !reward.manageable ? "" : "none";
  [
    redeemTitleInput,
    redeemCostInput,
    redeemPromptInput,
    redeemRequireInput,
    redeemColorTrigger,
    redeemEnabledOnTwitch,
    redeemSkipQueue,
  ].forEach((el) => {
    el.disabled = !manageable;
  });

  redeemTitleInput.value = reward ? reward.title : "";
  redeemCostInput.value = reward ? reward.cost : 100;
  redeemPromptInput.value = reward ? reward.prompt || "" : "";
  redeemRequireInput.checked = reward ? Boolean(reward.is_user_input_required) : false;
  setRedeemColorDisplay(reward && reward.background_color ? reward.background_color : "#8b5cf6");
  redeemEnabledOnTwitch.checked = reward ? reward.is_enabled !== false : true;
  redeemSkipQueue.checked = reward ? Boolean(reward.should_redemptions_skip_request_queue) : false;

  currentRedeemAction = cfg?.action || "message";
  document.querySelectorAll(".redeem-action-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.action === currentRedeemAction);
  });
  redeemMessageFields.style.display = currentRedeemAction === "message" ? "" : "none";
  redeemCounterFields.style.display = currentRedeemAction === "counter" ? "" : "none";
  redeemSnackFields.style.display = currentRedeemAction === "snackCheckin" ? "" : "none";
  redeemSfxFields.style.display = currentRedeemAction === "sfx" ? "" : "none";
  redeemSfxQueueNote.style.display = currentRedeemAction === "sfx" ? "" : "none";
  pendingRedeemSfxPath = null;
  redeemSfxFile.value = cfg?.sfxFile || "";

  redeemRepliesList.innerHTML = "";
  const replies = cfg?.replies?.length ? cfg.replies : [""];
  replies.forEach((r) => addRedeemReplyRow(r));

  refreshRedeemCounterSuggestions();
  redeemCounterName.value = cfg?.counter || "";
  redeemCounterAction.value = cfg?.counterAction || "view";
  redeemCounterStepField.style.display = redeemCounterAction.value === "view" ? "none" : "";
  redeemCounterStep.value = cfg?.step || 1;
  redeemCounterTemplate.value = cfg?.template || "";

  redeemSnackAmount.value = cfg?.snackAmount || 1;
  redeemSnackTemplate.value = cfg?.snackTemplate || "";

  setCheckedMinTiers(cfg ? normalizeMinSubTiers(cfg) : [0]);
  redeemCooldownSeconds.value = cfg?.cooldown?.seconds || 10;
  setCooldownMode("redeemCooldownToggle", "redeemCooldownMode", "redeemCooldownSeconds", cfg?.cooldown?.mode || "none");

  redeemConfigEnabled.checked = cfg ? cfg.enabled !== false : true;

  updateSkipQueueWarningVisibility();

  redeemFormOverlay.classList.add("open");
  redeemTitleInput.focus();
}

function closeRedeemForm() {
  redeemFormOverlay.classList.remove("open");
  editingReward = null;
}

document.getElementById("addRedeem").onclick = () => openRedeemForm(null);
document.getElementById("redeemFormClose").onclick = closeRedeemForm;
document.getElementById("redeemFormCancel").onclick = closeRedeemForm;
document.getElementById("refreshRedeems").onclick = loadRedeemsPage;

redeemFormOverlay.addEventListener("click", (e) => {
  if (e.target === redeemFormOverlay) closeRedeemForm();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && redeemFormOverlay.classList.contains("open")) closeRedeemForm();
});

async function buildRedeemConfig() {
  const cfg = {
    action: currentRedeemAction,
    minSubTiers: getCheckedMinTiers(),
    cooldown: {
      mode: redeemCooldownMode.value,
      seconds: redeemCooldownMode.value === "none" ? 0 : parseInt(redeemCooldownSeconds.value, 10) || 0,
    },
    enabled: redeemConfigEnabled.checked,
  };

  if (currentRedeemAction === "counter") {
    cfg.counter = redeemCounterName.value.trim();
    cfg.counterAction = redeemCounterAction.value;
    cfg.step = parseInt(redeemCounterStep.value, 10) || 1;
    cfg.template = redeemCounterTemplate.value.trim() || "{value}";
  } else if (currentRedeemAction === "snackCheckin") {
    cfg.snackAmount = parseInt(redeemSnackAmount.value, 10) || 1;
    cfg.snackTemplate = redeemSnackTemplate.value.trim() || "{user} now has {value} Smoky snack(s)!";
  } else if (currentRedeemAction === "sfx") {
    // A freshly-picked file still needs copying into sfx/ — an unchanged
    // one (editing without touching the picker) is already in there.
    cfg.sfxFile = pendingRedeemSfxPath
      ? await invoke("import_sfx_file", { sourcePath: pendingRedeemSfxPath })
      : redeemSfxFile.value;
  } else {
    const replies = Array.from(redeemRepliesList.querySelectorAll("input"))
      .map((input) => input.value.trim())
      .filter(Boolean);
    cfg.replies = replies.length ? replies : [""];
  }

  return cfg;
}

async function saveRedeemConfigs() {
  await invoke("save_list", { name: "redeems", content: redeemConfigs });
}

document.getElementById("redeemFormSave").onclick = async () => {
  const saveBtn = document.getElementById("redeemFormSave");

  if (currentRedeemAction === "counter" && !redeemCounterName.value.trim()) {
    alert("Counter redeems need a counter name.");
    return;
  }

  if (currentRedeemAction === "sfx" && !redeemSfxFile.value) {
    alert("Pick a sound file for this redeem.");
    return;
  }

  if (getCheckedMinTiers().length === 0) {
    alert("Pick at least one option for the minimum sub tier.");
    return;
  }

  const manageable = !editingReward || editingReward.manageable;
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving...";

  try {
    let rewardId = editingReward ? editingReward.id : null;

    if (manageable) {
      const { headers, broadcasterId } = await getStreamerHelixContext();
      const payload = {
        title: redeemTitleInput.value.trim(),
        cost: parseInt(redeemCostInput.value, 10) || 1,
        prompt: redeemPromptInput.value.trim(),
        is_user_input_required: redeemRequireInput.checked,
        background_color: redeemColorInput.value,
        is_enabled: redeemEnabledOnTwitch.checked,
        should_redemptions_skip_request_queue: redeemSkipQueue.checked,
      };

      if (!payload.title) {
        alert("Title can't be empty.");
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Redeem";
        return;
      }

      const url = editingReward
        ? `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${editingReward.id}`
        : `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`;

      const res = await fetch(url, {
        method: editingReward ? "PATCH" : "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `Twitch returned ${res.status}`);
      }

      const data = await res.json();
      rewardId = data.data?.[0]?.id || rewardId;
    }

    if (!rewardId) throw new Error("Could not determine the reward's ID.");

    redeemConfigs[rewardId] = await buildRedeemConfig();
    await saveRedeemConfigs();

    closeRedeemForm();
    await loadRedeemsPage();
  } catch (e) {
    console.error("[REDEEMS] Save failed:", e);
    alert("Couldn't save this redeem:\n" + e.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Redeem";
  }
};

document.getElementById("redeemFormDelete").onclick = async () => {
  if (!editingReward) return;

  const manageable = editingReward.manageable;
  const confirmMsg = manageable
    ? `Delete "${editingReward.title}" from Twitch entirely? This can't be undone.`
    : `Remove this bot's action/constraints from "${editingReward.title}"? The reward itself stays on Twitch.`;

  if (!confirm(confirmMsg)) return;

  const deleteBtn = document.getElementById("redeemFormDelete");
  deleteBtn.disabled = true;

  try {
    if (manageable) {
      const { headers, broadcasterId } = await getStreamerHelixContext();
      const res = await fetch(
        `https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=${broadcasterId}&id=${editingReward.id}`,
        { method: "DELETE", headers }
      );
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.message || `Twitch returned ${res.status}`);
      }
    }

    delete redeemConfigs[editingReward.id];
    await saveRedeemConfigs();

    closeRedeemForm();
    await loadRedeemsPage();
  } catch (e) {
    console.error("[REDEEMS] Delete failed:", e);
    alert("Couldn't delete this redeem:\n" + e.message);
  } finally {
    deleteBtn.disabled = false;
  }
};

/* ---------- SONG REQUESTS PAGE ---------- */

const songsNav = document.getElementById("songsNav");
let songsLoaded = false;
let songQueueData = [];
// Reward id from saved settings, applied to the dropdown once the reward
// fetch (a separate async call) actually populates its options.
let songRequestsPendingRedeemId = "";

songsNav.onclick = () => {
  setActive(songsNav);
  showPage(songsPage);
  if (!songsLoaded) {
    songsLoaded = true;
    loadSongsPage();
  }
};

const srTabSettings = document.getElementById("srTabSettings");
const srTabQueue = document.getElementById("srTabQueue");
const srSlider = document.getElementById("srSlider");

function showSongsTab(tab) {
  const showQueue = tab === "queue";
  srSlider.classList.toggle("show-queue", showQueue);
  srTabSettings.classList.toggle("active", !showQueue);
  srTabQueue.classList.toggle("active", showQueue);
}

srTabSettings.onclick = () => showSongsTab("settings");
srTabQueue.onclick = () => showSongsTab("queue");

function setSpotifyConnected(connected) {
  const status = document.getElementById("spotifyStatus");
  const disconnectBtn = document.getElementById("disconnectSpotify");
  if (connected) {
    status.textContent = "● Connected";
    status.classList.remove("stopped");
    status.classList.add("running");
    disconnectBtn.style.display = "";
  } else {
    status.textContent = "● Not Connected";
    status.classList.remove("running");
    status.classList.add("stopped");
    disconnectBtn.style.display = "none";
  }
}

async function loadSongsPage() {
  try {
    const env = await invoke("load_env");
    document.getElementById("spotifyClientId").value = env.SPOTIFY_CLIENT_ID || "";
    document.getElementById("spotifyClientSecret").value = env.SPOTIFY_CLIENT_SECRET || "";
    if (env.SPOTIFY_REDIRECT_URI) document.getElementById("spotifyRedirectUri").value = env.SPOTIFY_REDIRECT_URI;
    setSpotifyConnected(Boolean(env.SPOTIFY_REFRESH_TOKEN));
    document.getElementById("nowPlayingOverlayUrl").value = `http://localhost:${env.SFX_SERVER_PORT || 8420}/nowplaying`;
  } catch (err) {
    console.error(err);
  }

  try {
    const settings = await invoke("load_list", { name: "songRequestSettings" });
    document.getElementById("srChatEnabled").checked = Boolean(settings.chatEnabled);
    document.getElementById("srChatCommand").value = settings.chatCommand || "!sr";
    document.getElementById("srChannelPointsEnabled").checked = Boolean(settings.channelPointsEnabled);
    document.getElementById("srCooldown").value = settings.cooldownSeconds || 0;
    document.getElementById("srMaxDuration").value = settings.maxDurationMinutes || 0;
    document.getElementById("srPromoteBeforeEnd").value = settings.promoteBeforeEndSeconds || 5;
    document.getElementById("srQueueDisplayCount").value = settings.queueDisplayCount || 4;
    document.getElementById("srPlaylistId").value = settings.addToPlaylistId || "";

    const allowedChatRoles = settings.chatPermissions || ["follower"];
    document.querySelectorAll('#srChatPermissionChecks input[type="checkbox"]').forEach((cb) => {
      cb.checked = allowedChatRoles.includes(cb.value);
    });

    const limits = settings.perTierLimits || {};
    document.getElementById("srLimitFollower").value = limits.follower ?? 1;
    document.getElementById("srLimitVip").value = limits.vip ?? 2;
    document.getElementById("srLimitModerator").value = limits.moderator ?? 0;
    document.getElementById("srLimitSubT1").value = limits.subT1 ?? 2;
    document.getElementById("srLimitSubT2").value = limits.subT2 ?? 3;
    document.getElementById("srLimitSubT3").value = limits.subT3 ?? 5;

    songRequestsPendingRedeemId = settings.redeemId || "";
  } catch (err) {
    console.error(err);
  }

  try {
    const bl = await invoke("load_list", { name: "songBlocklist" });
    document.getElementById("srBlockedUsersBox").value = (bl.users || []).join("\n");
    document.getElementById("srBlockedSongsBox").value = (bl.songs || []).join("\n");
    document.getElementById("srBlockedArtistsBox").value = (bl.artists || []).join("\n");
    updateSongBlocklistCounts();
  } catch (err) {
    console.error(err);
  }

  loadSongRequestRewards();
  loadSongQueue();
}

// Reuses the same Helix reward listing the Redeems page already implements
// (getStreamerHelixContext/fetchRewardsFromTwitch, defined above) — this
// page only needs the plain list, not the .manageable annotation.
async function loadSongRequestRewards() {
  const select = document.getElementById("srRedeemSelect");
  select.innerHTML = '<option value="">Loading rewards…</option>';
  try {
    const rewards = await fetchRewardsFromTwitch();
    select.innerHTML =
      '<option value="">(none selected)</option>' +
      rewards.map((r) => `<option value="${r.id}">${escapeHtml(r.title)}</option>`).join("");
    select.value = songRequestsPendingRedeemId || "";
  } catch (e) {
    console.error("[SONGREQ] Failed to load rewards:", e);
    select.innerHTML = `<option value="">Couldn't load rewards: ${escapeHtml(e.message || String(e))}</option>`;
  }
}

document.getElementById("connectSpotify").onclick = async () => {
  const btn = document.getElementById("connectSpotify");
  const clientId = document.getElementById("spotifyClientId").value.trim();
  const clientSecret = document.getElementById("spotifyClientSecret").value.trim();

  if (!clientId || !clientSecret) {
    alert("Enter your Spotify app's Client ID and Client Secret first.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Connecting… (check your browser)";

  try {
    await invoke("spotify_login", { clientId, clientSecret });
    setSpotifyConnected(true);

    // Without this, a running bot process keeps the stale (unconfigured)
    // spotifyAuth state in memory forever — every !sr would silently fail
    // with "Spotify isn't connected yet." until something else happened to
    // restart it. Same reasoning as every Twitch Connect button already.
    if (botRunning) {
      await invoke("stop_bot");
      await invoke("start_bot");
    }
  } catch (e) {
    alert("Spotify connection failed:\n" + e);
  } finally {
    btn.disabled = false;
    btn.textContent = "Connect Spotify";
  }
};

document.getElementById("disconnectSpotify").onclick = async () => {
  if (!confirm("Disconnect Spotify? You'll need to reconnect to use song requests again.")) return;
  await invoke("save_env", { env: { SPOTIFY_ACCESS_TOKEN: "", SPOTIFY_REFRESH_TOKEN: "" } });
  setSpotifyConnected(false);

  // Otherwise a running bot keeps using its still-valid in-memory access
  // token indefinitely, ignoring the disconnect entirely until restarted.
  if (botRunning) {
    await invoke("stop_bot");
    await invoke("start_bot");
  }
};

document.getElementById("copySpotifyRedirectUri").onclick = async () => {
  const btn = document.getElementById("copySpotifyRedirectUri");
  await navigator.clipboard.writeText(document.getElementById("spotifyRedirectUri").value);
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = "Copy"; }, 1200);
};

document.getElementById("openSpotifyDevDashboard").onclick = () =>
  invoke("open_url", { url: "https://developer.spotify.com/dashboard" });

document.getElementById("copyNowPlayingOverlayUrl").onclick = async () => {
  const btn = document.getElementById("copyNowPlayingOverlayUrl");
  await navigator.clipboard.writeText(document.getElementById("nowPlayingOverlayUrl").value);
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = "Copy"; }, 1200);
};

function updateSongBlocklistCounts() {
  document.getElementById("srBlockedUsersCount").textContent =
    document.getElementById("srBlockedUsersBox").value.split("\n").filter((x) => x.trim()).length;
  document.getElementById("srBlockedSongsCount").textContent =
    document.getElementById("srBlockedSongsBox").value.split("\n").filter((x) => x.trim()).length;
  document.getElementById("srBlockedArtistsCount").textContent =
    document.getElementById("srBlockedArtistsBox").value.split("\n").filter((x) => x.trim()).length;
}
document.getElementById("srBlockedUsersBox").oninput = updateSongBlocklistCounts;
document.getElementById("srBlockedSongsBox").oninput = updateSongBlocklistCounts;
document.getElementById("srBlockedArtistsBox").oninput = updateSongBlocklistCounts;

document.getElementById("saveSongSettings").onclick = async () => {
  const btn = document.getElementById("saveSongSettings");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const settings = {
      chatEnabled: document.getElementById("srChatEnabled").checked,
      chatCommand: document.getElementById("srChatCommand").value.trim() || "!sr",
      channelPointsEnabled: document.getElementById("srChannelPointsEnabled").checked,
      redeemId: document.getElementById("srRedeemSelect").value,
      cooldownSeconds: parseInt(document.getElementById("srCooldown").value, 10) || 0,
      maxDurationMinutes: parseInt(document.getElementById("srMaxDuration").value, 10) || 0,
      promoteBeforeEndSeconds: parseInt(document.getElementById("srPromoteBeforeEnd").value, 10) || 5,
      queueDisplayCount: parseInt(document.getElementById("srQueueDisplayCount").value, 10) || 4,
      addToPlaylistId: document.getElementById("srPlaylistId").value.trim(),
      chatPermissions: Array.from(
        document.querySelectorAll('#srChatPermissionChecks input[type="checkbox"]:checked')
      ).map((cb) => cb.value),
      perTierLimits: {
        follower: parseInt(document.getElementById("srLimitFollower").value, 10) || 0,
        vip: parseInt(document.getElementById("srLimitVip").value, 10) || 0,
        moderator: parseInt(document.getElementById("srLimitModerator").value, 10) || 0,
        subT1: parseInt(document.getElementById("srLimitSubT1").value, 10) || 0,
        subT2: parseInt(document.getElementById("srLimitSubT2").value, 10) || 0,
        subT3: parseInt(document.getElementById("srLimitSubT3").value, 10) || 0,
      },
    };
    await invoke("save_list", { name: "songRequestSettings", content: settings });
    btn.textContent = "Saved!";
  } catch (e) {
    alert("Error saving song request settings: " + e);
  } finally {
    setTimeout(() => { btn.textContent = "Save Settings"; btn.disabled = false; }, 1500);
  }
};

document.getElementById("saveSongBlocklist").onclick = async () => {
  const btn = document.getElementById("saveSongBlocklist");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const blocklist = {
      users: document.getElementById("srBlockedUsersBox").value.split("\n").map((x) => x.trim()).filter(Boolean),
      songs: document.getElementById("srBlockedSongsBox").value.split("\n").map((x) => x.trim()).filter(Boolean),
      artists: document.getElementById("srBlockedArtistsBox").value.split("\n").map((x) => x.trim()).filter(Boolean),
    };
    await invoke("save_list", { name: "songBlocklist", content: blocklist });
    btn.textContent = "Saved!";
  } catch (e) {
    alert("Error saving blocklist: " + e);
  } finally {
    setTimeout(() => { btn.textContent = "Save Blocklist"; btn.disabled = false; }, 1500);
  }
};

async function loadSongQueue(silent = false) {
  const list = document.getElementById("songQueueList");
  if (!silent) list.innerHTML = '<div class="commands-empty">Loading queue…</div>';
  try {
    const data = await invoke("load_list", { name: "songQueue" });
    songQueueData = Array.isArray(data) ? data : [];
    renderSongQueue();
  } catch (e) {
    console.error(e);
    if (!silent) {
      songQueueData = [];
      list.innerHTML = '<div class="commands-empty">Couldn\'t load the queue.</div>';
      document.getElementById("songQueueCount").textContent = "0";
    }
  }
}
document.getElementById("refreshSongQueue").onclick = () => loadSongQueue();

// Keeps the queue current without needing a manual click — skips the work
// entirely when the Song Requests page isn't even visible or the window is
// hidden/minimized, same efficiency pattern refreshDashboard() already uses.
setInterval(() => {
  if (songsPage.style.display === "none") return;
  if (document.hidden) return;
  loadSongQueue(true);
}, 5000);

function renderSongQueue() {
  const list = document.getElementById("songQueueList");
  document.getElementById("songQueueCount").textContent = songQueueData.length;

  if (!songQueueData.length) {
    list.innerHTML = '<div class="commands-empty">No song requests yet.</div>';
    return;
  }

  list.innerHTML = "";
  // Most recent first — the underlying file stays append-order (FIFO), this
  // reversal is purely a display choice.
  songQueueData.slice().reverse().forEach((req) => {
    const card = document.createElement("div");
    card.className = "command-card";
    const isPending = req.status === "pending";
    card.innerHTML = `
      <div class="command-card-row">
        <span class="command-trigger">${escapeHtml(req.title || req.query)}</span>
        <span class="command-description">${escapeHtml(req.artist || "")}</span>
        <span class="cmd-badge muted">${escapeHtml(req.requestedBy)}</span>
        <span class="cmd-badge muted">${req.source === "channelPoints" ? "Channel Points" : "Chat"}</span>
        <span class="cmd-badge${isPending ? "" : " muted"}">${isPending ? "Pending" : "In Spotify Queue"}</span>
        ${isPending ? '<div class="cmd-actions"><button type="button" class="command-edit-btn">Remove</button></div>' : ""}
      </div>
    `;
    // Removal only makes sense while still "pending" — once a request is
    // "sent", it's already in Spotify's real queue and there's no API to
    // pull it back out, so the button isn't shown for those at all.
    const removeBtn = card.querySelector(".command-edit-btn");
    if (removeBtn) {
      removeBtn.onclick = async () => {
        songQueueData = songQueueData.filter((r) => r.id !== req.id);
        await invoke("save_list", { name: "songQueue", content: songQueueData });
        renderSongQueue();
      };
    }
    list.appendChild(card);
  });
}

// Catch up immediately when the window comes back into view instead of
// leaving the dashboard stale for up to 4s after being backgrounded.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshDashboard();
});

refreshDashboard();
setInterval(refreshDashboard, 4000);