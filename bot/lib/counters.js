const store = require("./persistence/customCommands");

/**
 * Applies a view/increment/decrement action to a named counter and returns
 * its resulting value. Shared by commands/customCommands.js and
 * handlers/redemptions.js so a chat command and a Channel Points redeem can
 * reference and mutate the exact same counter.
 */
function applyCounterAction(name, action, step = 1) {
  let value = store.counters[name] ?? 0;

  if (action === "increment") {
    value += step;
    store.counters[name] = value;
    store.saveCounters();
  } else if (action === "decrement") {
    value -= step;
    store.counters[name] = value;
    store.saveCounters();
  }
  // "view" (or unset) — read only, no mutation.

  return value;
}

module.exports = { applyCounterAction };
