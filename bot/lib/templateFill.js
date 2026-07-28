/**
 * Fills a {placeholder} template. Three kinds of placeholder:
 *   {someKey}        -> vars.someKey, or left untouched if vars doesn't have it
 *   {random:1-100}    -> a random integer in that inclusive range
 *   {choice:a|b|c}    -> one of the pipe-separated options, picked at random
 *
 * Shared by lib/messageOverrides.js (built-in command messages) and
 * commands/customCommands.js (streamer-authored commands) so both systems
 * support the same placeholders instead of drifting apart.
 */
function fillTemplate(template, vars = {}) {
  return String(template).replace(/\{([^{}]+)\}/g, (match, expr) => {
    if (expr.startsWith("random:")) {
      const [minStr, maxStr] = expr.slice(7).split("-");
      const min = parseInt(minStr, 10);
      const max = parseInt(maxStr, 10);
      if (Number.isNaN(min) || Number.isNaN(max)) return match;

      const lo = Math.min(min, max);
      const hi = Math.max(min, max);
      return String(Math.floor(Math.random() * (hi - lo + 1)) + lo);
    }

    if (expr.startsWith("choice:")) {
      const options = expr
        .slice(7)
        .split("|")
        .map((s) => s.trim())
        .filter(Boolean);
      if (!options.length) return match;
      return options[Math.floor(Math.random() * options.length)];
    }

    return expr in vars ? String(vars[expr]) : match;
  });
}

module.exports = { fillTemplate };
