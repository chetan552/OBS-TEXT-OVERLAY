// =============================================================================
// Channel store — the list of churches using this server
// =============================================================================
// Backed by a single JSON file on disk. A deployment serving a handful of
// churches doesn't need a database, and a plain file is easy for an admin to
// back up, inspect, and hand-edit in an emergency.
//
// Everything is cached in memory; the file is the durable copy. Writes are
// atomic (write to a temp file, then rename) so a crash mid-save can never
// leave a truncated channels.json behind.

const fs = require("fs");
const path = require("path");

const { hashPassword, randomToken } = require("./auth");
const { defaultTheme, sanitizeTheme } = require("./theme");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "channels.json");
const SECRET_FILE = path.join(DATA_DIR, "session-secret");

// Channel ids appear in URLs, so keep them to a conservative slug shape.
const CHANNEL_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// ---- In-memory state --------------------------------------------------------
let db = { version: 1, channels: {} };
let viewTokenIndex = new Map(); // viewToken -> channelId

// "Last used" is derived, high-churn, and worthless after a restart, so it
// lives only in memory. Keeping it out of the file means the server never
// writes channels.json except in response to an explicit admin action —
// which is what makes it safe for the CLI to edit the same file.
const lastActive = new Map(); // channelId -> epoch ms

// The exact mtime of the file as we last wrote it, so the watcher can tell
// our own save from someone else's edit. Deliberately an identity check and
// not a time window: a window would suppress a real edit that lands inside
// it, and because fs.watchFile only reports transitions, that edit would
// then never be picked up at all.
let selfWriteMtimeMs = -1;

// ---- Load / save ------------------------------------------------------------

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function rebuildIndex() {
  viewTokenIndex = new Map();
  for (const channel of Object.values(db.channels)) {
    viewTokenIndex.set(channel.viewToken, channel.id);
  }
}

function load() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    db = {
      version: parsed.version || 1,
      channels: parsed.channels || {},
    };
  } catch (err) {
    if (err.code !== "ENOENT") {
      // A corrupt file is worth failing loudly on: silently starting with an
      // empty channel list would knock every church offline at once.
      throw new Error(`Could not read ${DATA_FILE}: ${err.message}`);
    }
    db = { version: 1, channels: {} };
    save();
  }
  rebuildIndex();
  return db;
}

function save() {
  ensureDataDir();
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
  try {
    selfWriteMtimeMs = fs.statSync(DATA_FILE).mtimeMs;
  } catch {
    selfWriteMtimeMs = -1; // Worst case we reload our own write, which is harmless
  }
}

/**
 * Reload when channels.json changes underneath us — that's how an edit made
 * by the CLI (or a restored backup) reaches a running server without a
 * restart. Our own writes are ignored so a save never triggers a reload.
 *
 * fs.watchFile polls rather than using FSEvents; at a 2 s interval that is
 * negligible, and it behaves consistently with the atomic rename in save().
 */
function watch(onReload) {
  fs.watchFile(DATA_FILE, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    if (curr.mtimeMs === selfWriteMtimeMs) return; // our own save
    try {
      load();
      if (onReload) onReload(listChannels().length);
    } catch (err) {
      console.error(`[store] Reload failed, keeping current channels: ${err.message}`);
    }
  });
}

/**
 * The HMAC key for session cookies. Persisted next to the channel data so
 * operators stay logged in across restarts. Generated on first run.
 */
function loadOrCreateSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;

  ensureDataDir();
  try {
    const existing = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const secret = randomToken(48);
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}

// ---- Reads ------------------------------------------------------------------

/** Every channel, without password hashes, sorted by display name. */
function listChannels() {
  return Object.values(db.channels)
    .map(publicView)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getChannel(id) {
  return db.channels[id] || null;
}

/** Resolve a view token to its channel. Returns null for unknown/disabled. */
function getChannelByViewToken(token) {
  if (!token) return null;
  const id = viewTokenIndex.get(token);
  if (!id) return null;
  const channel = db.channels[id];
  if (!channel || channel.disabled) return null;
  return channel;
}

/** Strip the password hash before anything reaches the admin UI or a log. */
function publicView(channel) {
  const active = lastActive.get(channel.id);
  return {
    id: channel.id,
    name: channel.name,
    viewToken: channel.viewToken,
    disabled: Boolean(channel.disabled),
    createdAt: channel.createdAt,
    lastActiveAt: active ? new Date(active).toISOString() : null,
  };
}

// ---- Writes -----------------------------------------------------------------

function createChannel({ id, name, password }) {
  if (!CHANNEL_ID_PATTERN.test(id)) {
    throw new Error(
      "Channel id must be 1–40 characters of lowercase letters, numbers and hyphens"
    );
  }
  if (db.channels[id]) {
    throw new Error(`Channel "${id}" already exists`);
  }
  if (!name || !name.trim()) {
    throw new Error("Channel name is required");
  }
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const channel = {
    id,
    name: name.trim(),
    passwordHash: hashPassword(password),
    viewToken: randomToken(),
    disabled: false,
    theme: defaultTheme(),
    createdAt: new Date().toISOString(),
  };

  db.channels[id] = channel;
  viewTokenIndex.set(channel.viewToken, id);
  save();
  return publicView(channel);
}

function setPassword(id, password) {
  const channel = mustGet(id);
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  channel.passwordHash = hashPassword(password);
  save();
  return publicView(channel);
}

/**
 * Issue a fresh view token. The old one stops working immediately, which is
 * the lever to pull when a church's overlay URL leaks.
 */
function rotateViewToken(id) {
  const channel = mustGet(id);
  viewTokenIndex.delete(channel.viewToken);
  channel.viewToken = randomToken();
  viewTokenIndex.set(channel.viewToken, id);
  save();
  return publicView(channel);
}

function setDisabled(id, disabled) {
  const channel = mustGet(id);
  channel.disabled = Boolean(disabled);
  save();
  return publicView(channel);
}

/**
 * Replace a channel's theme. Input is sanitized against the schema, so a
 * partial or hostile payload can only ever produce a valid theme.
 */
function setTheme(id, theme) {
  const channel = mustGet(id);
  channel.theme = sanitizeTheme(theme);
  save();
  return channel.theme;
}

/** Restore the original shipped design. */
function resetTheme(id) {
  const channel = mustGet(id);
  channel.theme = defaultTheme();
  save();
  return channel.theme;
}

/**
 * A channel's theme, always complete and valid. Channels created before
 * theming existed have no `theme` key, so this fills in the defaults rather
 * than making the caller handle undefined.
 */
function getTheme(id) {
  const channel = db.channels[id];
  if (!channel) return defaultTheme();
  return sanitizeTheme(channel.theme);
}

function renameChannel(id, name) {
  const channel = mustGet(id);
  if (!name || !name.trim()) throw new Error("Channel name is required");
  channel.name = name.trim();
  save();
  return publicView(channel);
}

function deleteChannel(id) {
  const channel = mustGet(id);
  viewTokenIndex.delete(channel.viewToken);
  delete db.channels[id];
  save();
}

/** Record activity so the admin page can show which churches are in use. */
function touchChannel(id) {
  lastActive.set(id, Date.now());
}

function mustGet(id) {
  const channel = db.channels[id];
  if (!channel) throw new Error(`No such channel: ${id}`);
  return channel;
}

module.exports = {
  DATA_DIR,
  DATA_FILE,
  CHANNEL_ID_PATTERN,
  load,
  watch,
  loadOrCreateSessionSecret,
  listChannels,
  getChannel,
  getChannelByViewToken,
  publicView,
  createChannel,
  setPassword,
  rotateViewToken,
  setDisabled,
  setTheme,
  resetTheme,
  getTheme,
  renameChannel,
  deleteChannel,
  touchChannel,
};
