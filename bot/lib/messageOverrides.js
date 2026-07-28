const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const { DATA_DIR } = require("./paths");
const { ensureDataDir, atomicWriteFileSync } = require("./persistence/fsUtils");
const { fillTemplate } = require("./templateFill");

/* ------------------------------------------------------------------ */
/* Built-in command message overrides                                  */
/*                                                                     */
/* Command modules that send user-facing text register their default   */
/* messages here (once, at module load) via registerDefaults(). This    */
/* module is the single source of truth for what's editable — nothing   */
/* about when or whether a message gets sent lives here, only the text. */
/*                                                                     */
/* Two files on disk:                                                  */
/*   commandMessageCatalog.json — bot-generated manifest (what CAN be   */
/*     overridden, with defaults + descriptions + placeholders), for    */
/*     the UI to read and build an editor from. Rewritten on every      */
/*     boot; never hand-edited.                                        */
/*   commandMessages.json — the actual overrides, edited by the UI (or  */
/*     by hand). Hot-reloaded via chokidar like allowlist/VIPList.      */
/* ------------------------------------------------------------------ */

const MESSAGES_PATH = path.join(DATA_DIR, "commandMessages.json");
const CATALOG_PATH = path.join(DATA_DIR, "commandMessageCatalog.json");

// commandKey -> { messageKey -> { default, description, placeholders } }
const catalog = {};
// commandKey -> { messageKey -> "override text" }
const overrides = {};

/**
 * Called once at module load by any command file that has editable
 * messages. `entries` is { messageKey: { default, description, placeholders } }.
 */
function registerDefaults(commandKey, entries) {
  catalog[commandKey] = entries;
}

function writeCatalog() {
  ensureDataDir();
  try {
    atomicWriteFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
  } catch (e) {
    console.warn("Failed to write commandMessageCatalog.json:", e.message);
  }
}

function loadOverrides() {
  ensureDataDir();
  if (!fs.existsSync(MESSAGES_PATH)) {
    fs.writeFileSync(MESSAGES_PATH, JSON.stringify({}, null, 2));
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(MESSAGES_PATH, "utf8"));
    for (const key of Object.keys(overrides)) delete overrides[key];
    Object.assign(overrides, parsed);
    console.log(`Loaded command message overrides: ${Object.keys(overrides).length} command(s) customized`);
  } catch (e) {
    console.error("Failed to load commandMessages.json:", e);
  }
}

function watch() {
  chokidar.watch(MESSAGES_PATH, { ignoreInitial: true }).on("change", () => {
    console.log("[RAHHH] Reloading command message overrides");
    try {
      loadOverrides();
    } catch (e) {
      console.error("Message override reload failed:", e);
    }
  });
}

/**
 * Resolves a command's message: the override text if one's been set for
 * commandKey/messageKey, else defaultTemplate — either way with {placeholder}
 * substitution from vars applied (see lib/templateFill.js for what's
 * supported, e.g. {random:1-100}, {choice:a|b|c}).
 */
function getMessage(commandKey, messageKey, defaultTemplate, vars = {}) {
  const template = overrides[commandKey]?.[messageKey] ?? defaultTemplate;
  return fillTemplate(template, vars);
}

/** Called once at bootstrap, after every command module has been required
 * (and so every registerDefaults() call has already run) — writes the
 * catalog and loads/watches the actual override values. */
function init() {
  writeCatalog();
  loadOverrides();
  watch();
}

module.exports = { registerDefaults, getMessage, init };
