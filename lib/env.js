// =============================================================================
// .env loader
// =============================================================================
// Deliberately dependency-free, and deliberately does NOT override variables
// that are already set. In production the environment is the source of truth —
// launchd supplies it from the plist, Render from the dashboard — and a stale
// .env left in the checkout must never quietly win over it.
//
// Supports what a config file actually needs: KEY=value, `export KEY=value`,
// # comments, blank lines, and single- or double-quoted values.

const fs = require("fs");
const path = require("path");

/**
 * Load `.env` into process.env. Missing file is not an error — that's the
 * normal case in production.
 *
 * @returns {string[]} names of the variables this call actually set
 */
function loadEnv(file = path.join(__dirname, "..", ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }

  const applied = [];

  for (let line of raw.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("export ")) line = line.slice(7).trim();

    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();

    // Strip matching quotes; an unquoted value keeps any trailing comment out
    // of the picture only when it's clearly separated, since passwords may
    // legitimately contain '#'.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    // The real environment always wins.
    if (process.env[key] !== undefined) continue;

    process.env[key] = value;
    applied.push(key);
  }

  return applied;
}

module.exports = { loadEnv };
