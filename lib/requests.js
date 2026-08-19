// =============================================================================
// Account requests — churches ask for a channel, admin approves in the panel
// =============================================================================
// Backed by requests.json in DATA_DIR, with the same atomic-write discipline
// as the channel store. Approving creates the real channel and returns the
// generated password exactly once — it is never written to disk, so the admin
// must relay it (and can always reset it from the channel list if lost).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { randomToken } = require("./auth");
const { suggestPassword } = require("./password");
const store = require("./store");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "requests.json");

let requests = []; // newest first

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    requests = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Could not read ${DATA_FILE}: ${err.message}`);
    }
    requests = [];
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(requests, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}

function list() {
  return requests;
}

/** Sanitize a submitted field into a plain, bounded string. */
function cleanField(value, max) {
  const s = typeof value === "string" ? value.trim() : "";
  return s.slice(0, max);
}

// ---- Submission throttle ------------------------------------------------------
// Bots hit public forms; humans rarely submit more than once an hour. The
// honeypot field in the form catches the dumb ones, this catches the rest.

const SUBMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SUBMIT_MAX_PER_WINDOW = 3;
const submissions = new Map(); // ip -> [timestamp, ...]

/** Record this attempt; true when the IP has hit the limit. */
function throttle(ip) {
  const nowMs = Date.now();
  const recent = (submissions.get(ip) || []).filter((t) => nowMs - t < SUBMIT_WINDOW_MS);
  if (recent.length >= SUBMIT_MAX_PER_WINDOW) {
    submissions.set(ip, recent);
    return true;
  }
  recent.push(nowMs);
  submissions.set(ip, recent);
  return false;
}

function startCleanup() {
  const timer = setInterval(() => {
    const nowMs = Date.now();
    for (const [ip, times] of submissions) {
      const recent = times.filter((t) => nowMs - t < SUBMIT_WINDOW_MS);
      if (recent.length) submissions.set(ip, recent);
      else submissions.delete(ip);
    }
  }, 10 * 60 * 1000);
  timer.unref();
}

// ---- Lifecycle -----------------------------------------------------------------

function submit(fields) {
  const request = {
    id: randomToken(12),
    churchName: cleanField(fields.churchName, 100),
    contactName: cleanField(fields.contactName, 100),
    email: cleanField(fields.email, 200),
    notes: cleanField(fields.notes, 1000),
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  requests.unshift(request);
  save();
  return request;
}

function mustGet(id) {
  const request = requests.find((r) => r.id === id);
  if (!request) throw new Error("No such request");
  return request;
}

/** Slug a church name into a channel id. Names without usable letters (e.g.
 *  non-latin scripts) fall back to a random slug the admin can rename. */
function slugify(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (slug) return slug;
  return `church-${crypto.randomBytes(6).toString("hex")}`;
}

/** Create the channel for an approved request. Returns { request, channel,
 *  password } — the password appears here once and nowhere else. */
function approve(id) {
  const request = mustGet(id);
  if (request.status !== "pending") throw new Error("Request already resolved");

  const base = slugify(request.churchName);
  const password = suggestPassword();

  // The slug may collide with an existing channel; keep suffixing rather
  // than asking the admin to retype.
  let channel = null;
  for (let suffix = 2; !channel && suffix <= 999; suffix++) {
    const channelId = suffix === 2 ? base : `${base}-${suffix}`.slice(0, 40);
    try {
      channel = store.createChannel({
        id: channelId,
        name: request.churchName,
        password,
      });
    } catch (err) {
      if (!/already exists/.test(err.message)) throw err;
    }
  }
  if (!channel) throw new Error("Could not find a free channel id for this request");

  request.status = "approved";
  request.channelId = channel.id;
  request.approvedAt = new Date().toISOString();
  save();
  return { request, channel, password };
}

function dismiss(id) {
  const request = mustGet(id);
  if (request.status !== "pending") throw new Error("Request already resolved");
  request.status = "dismissed";
  request.dismissedAt = new Date().toISOString();
  save();
  return request;
}

/** Delete a request outright, whatever its status. Approving keeps the
 *  record for the audit trail; deleting is how the admin clears spam and
 *  stale entries out of the panel entirely. */
function remove(id) {
  const index = requests.findIndex((r) => r.id === id);
  if (index === -1) throw new Error("No such request");
  const [request] = requests.splice(index, 1);
  save();
  return request;
}

module.exports = {
  load,
  list,
  submit,
  approve,
  dismiss,
  remove,
  throttle,
  startCleanup,
  cleanField,
};
