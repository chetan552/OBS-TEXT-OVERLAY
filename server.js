// =============================================================================
// TextPresenter — multi-tenant WebSocket server
// =============================================================================
// One server instance hosts many independent channels (one per church).
// Channels never see each other's text: every socket is bound to exactly one
// channel at connection time, and broadcasts are scoped to that channel's
// socket set.
//
// Two kinds of credential, because the two kinds of page have very different
// constraints:
//
//   Control page   /c/<channel>              operator logs in with a password;
//                                            the session lives in a cookie.
//   Overlay/screen /v/<viewToken>/...        OBS and projectors can't fill in
//                                            a login form, so they authenticate
//                                            with an unguessable URL. View
//                                            sockets are strictly read-only —
//                                            a leaked overlay URL can watch,
//                                            but can never push text.
//
// Admin (/admin) manages channels and is gated by ADMIN_PASSWORD.

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

// Load .env before anything reads process.env. Variables already present in
// the environment (launchd, Render) are left alone.
const loadedFromEnvFile = require("./lib/env").loadEnv();

const store = require("./lib/store");
const theme = require("./lib/theme");
const loginGuard = require("./lib/login-guard");
const requests = require("./lib/requests");
const {
  verifyPasswordAsync,
  signSession,
  verifySession,
  parseCookies,
  serializeCookie,
} = require("./lib/auth");

// ---- Configuration ----------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KiB — far more than any verse needs
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds
const ADMIN_SESSION_MAX_AGE = 12 * 60 * 60; // 12 hours
const MESSAGE_COOLDOWN_MS = 150; // per channel, not per server
const HEARTBEAT_MS = 30_000;
// A church needs OBS + projector + control, so real usage is under a dozen.
// These caps are a backstop against a leaked view token flooding the server
// with sockets — every socket costs memory and a copy of each broadcast.
const MAX_SOCKETS_PER_CHANNEL = 300;
const MAX_TOTAL_SOCKETS = 2000;

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");

// Exact origins allowed to open a WebSocket, e.g.
// "https://text.example.org,http://192.168.1.50:3000".
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Allow any private-network / localhost origin in addition to the list above.
// This is what lets your own church's OBS and projector connect over the LAN
// while everyone else comes in through the public hostname.
const ALLOW_PRIVATE_ORIGINS = process.env.ALLOW_PRIVATE_ORIGINS !== "false";

// ---- Load persistent state --------------------------------------------------
store.load();
requests.load();
const SESSION_SECRET = store.loadOrCreateSessionSecret();

if (!ADMIN_PASSWORD) {
  console.warn(
    "[warn] ADMIN_PASSWORD is not set — the /admin panel is disabled.\n" +
      "       Put ADMIN_PASSWORD=... in .env (next to package.json), or set it\n" +
      "       in the environment. Channels can still be managed with `npm run channel`."
  );
}

// =============================================================================
// Views — HTML pages served only after an auth check
// =============================================================================
// These live outside the static directory on purpose. If they were served by
// express.static, anyone could fetch /control.html and skip the login.

const viewsDir = path.join(__dirname, "views");
const viewCache = new Map();

function renderView(name, config = {}) {
  let html = viewCache.get(name);
  if (html === undefined) {
    html = fs.readFileSync(path.join(viewsDir, `${name}.html`), "utf8");
    viewCache.set(name, html);
  }
  // Pages read their channel/token/URLs from window.__TP__ rather than
  // parsing their own location, so the URL scheme can change freely.
  const script = `<script>window.__TP__=${JSON.stringify(config).replace(
    /</g,
    "\\u003c"
  )};</script>`;
  return html.replace("<!--TP_CONFIG-->", script);
}

function sendView(res, name, config) {
  res.type("html").send(renderView(name, config));
}

// =============================================================================
// Express app
// =============================================================================

const app = express();

// cloudflared connects from localhost, so only loopback proxies are trusted.
// Trusting every proxy would let a client forge X-Forwarded-For and dodge
// rate limits.
app.set("trust proxy", "loopback");
app.disable("x-powered-by");

app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(express.json({ limit: "16kb" }));

// ---- Security headers -------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "font-src 'self' https://fonts.gstatic.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "script-src 'self' 'unsafe-inline'; " +
      "connect-src 'self' ws: wss:; " +
      "frame-ancestors 'self'"
  );
  if (isSecureRequest(req)) {
    // Browsers only honor HSTS over HTTPS, so only advertise it there — a
    // LAN-only http deployment must never learn a policy it can't satisfy.
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  next();
});

// absoluteUrl() builds copy-paste links from the Host header when PUBLIC_URL
// is unset, so a malformed Host must never reach the link builders.
const HOST_PATTERN = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/;
app.use((req, res, next) => {
  const host = req.get("host");
  if (host && !HOST_PATTERN.test(host)) {
    return res.status(400).type("text").send("Bad Request");
  }
  next();
});

// Only assets live here — every HTML page goes through a route with an auth check.
app.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
    dotfiles: "ignore",
  })
);

// ---- Session helpers --------------------------------------------------------

/** Cookies must be Secure in public (HTTPS) use but not over plain-http LAN. */
function isSecureRequest(req) {
  return req.secure || req.get("x-forwarded-proto") === "https";
}

function controlCookieName(channelId) {
  return `tp_c_${channelId.replace(/-/g, "_")}`;
}

function setSession(res, req, name, claims, maxAge) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(name, signSession(claims, SESSION_SECRET, maxAge), {
      maxAge,
      secure: isSecureRequest(req),
    })
  );
}

function clearSession(res, req, name) {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(name, "", { maxAge: 0, secure: isSecureRequest(req) })
  );
}

/** Claims for a valid operator session on this channel, or null. */
function readControlSession(req, channelId) {
  const cookies = parseCookies(req.headers.cookie);
  const claims = verifySession(cookies[controlCookieName(channelId)], SESSION_SECRET);
  if (!claims || claims.channel !== channelId) return null;
  return claims;
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const cookies = parseCookies(req.headers.cookie);
  const claims = verifySession(cookies.tp_admin, SESSION_SECRET);
  return Boolean(claims && claims.role === "admin");
}

// A brief delay on failed logins takes brute-forcing a channel password off
// the table without needing to track attempts across restarts.
function loginDelay() {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

// =============================================================================
// Routes — landing
// =============================================================================

app.get("/", (req, res) => {
  // No admin link on purpose: the panel is deliberately unadvertised, and
  // the administrator knows where it lives.
  sendView(res, "index", {});
});

app.get("/healthz", (req, res) => {
  res.json({ ok: true, channels: store.listChannels().length });
});

// ---- Account requests ---------------------------------------------------------
// Public form on the home page. Rate-limited per IP, a honeypot for bots,
// and every field is sanitized before it lands in requests.json.

app.post("/api/request", (req, res) => {
  const body = req.body || {};

  // Honeypot: hidden from humans, filled by bots. Pretend success.
  if (body.website) return res.json({ ok: true });

  if (requests.throttle(clientIp(req))) {
    return res.status(429).json({ error: "Too many requests — please try again in an hour." });
  }

  const churchName = requests.cleanField(body.churchName, 100);
  const email = requests.cleanField(body.email, 200);
  if (churchName.length < 2) {
    return res.status(400).json({ error: "Please tell us your church's name." });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: "That email address doesn't look right." });
  }

  requests.submit({
    churchName,
    contactName: requests.cleanField(body.contactName, 100),
    email,
    notes: requests.cleanField(body.notes, 1000),
  });
  console.log(`[request] Account request from "${churchName}" (${clientIp(req)})`);
  res.status(201).json({ ok: true });
});

// =============================================================================
// Routes — control page (operators)
// =============================================================================

app.get("/c/:channelId", (req, res) => {
  const { channelId } = req.params;
  const channel = store.getChannel(channelId);

  if (!channel || channel.disabled) {
    return res.status(404).type("html").send(renderView("not-found", {}));
  }

  if (!readControlSession(req, channelId)) {
    return sendView(res, "login", {
      channelId,
      channelName: channel.name,
      error: req.query.error === "1" ? "Incorrect password." : "",
    });
  }

  sendView(res, "control", {
    role: "control",
    channelId,
    channelName: channel.name,
    wsUrl: `/ws?channel=${encodeURIComponent(channelId)}`,
    designUrl: `/c/${encodeURIComponent(channelId)}/design`,
    overlayUrl: absoluteUrl(req, `/v/${channel.viewToken}/overlay.html`),
    screenUrl: absoluteUrl(req, `/v/${channel.viewToken}/screen.html`),
  });
});

// ---- Design page ------------------------------------------------------------
// Operators design their own church's look. It's their screen, and routing
// every tweak through the admin would make the feature useless in practice.

app.get("/c/:channelId/design", (req, res) => {
  const { channelId } = req.params;
  const channel = store.getChannel(channelId);

  if (!channel || channel.disabled) {
    return res.status(404).type("html").send(renderView("not-found", {}));
  }
  if (!readControlSession(req, channelId)) {
    return res.redirect(`/c/${encodeURIComponent(channelId)}`);
  }

  sendView(res, "design", {
    channelId,
    channelName: channel.name,
    theme: store.getTheme(channelId),
    defaults: theme.defaultTheme(),
    fonts: theme.FONTS.map((f) => ({ id: f.id, label: f.label })),
    fields: { overlay: theme.OVERLAY_FIELDS, screen: theme.SCREEN_FIELDS },
    controlUrl: `/c/${encodeURIComponent(channelId)}`,
  });
});

/** Save a theme. Applies live to everything connected to this channel. */
app.put("/c/:channelId/api/theme", (req, res) => {
  const { channelId } = req.params;
  if (!requireControl(req, res, channelId)) return;

  const saved = store.setTheme(channelId, req.body);
  broadcastTheme(channelId, saved);
  res.json({ theme: saved });
});

/** Restore the original shipped design. */
app.post("/c/:channelId/api/theme/reset", (req, res) => {
  const { channelId } = req.params;
  if (!requireControl(req, res, channelId)) return;

  const saved = store.resetTheme(channelId);
  broadcastTheme(channelId, saved);
  console.log(`[design] "${channelId}" reset to the default theme`);
  res.json({ theme: saved });
});

/** Guard for the operator-facing JSON endpoints. */
function requireControl(req, res, channelId) {
  const channel = store.getChannel(channelId);
  if (!channel || channel.disabled) {
    res.status(404).json({ error: "No such channel" });
    return false;
  }
  if (!readControlSession(req, channelId)) {
    res.status(401).json({ error: "Not signed in" });
    return false;
  }
  return true;
}

app.post("/c/:channelId/login", async (req, res) => {
  const { channelId } = req.params;
  const channel = store.getChannel(channelId);

  if (!channel || channel.disabled) {
    return res.status(404).type("html").send(renderView("not-found", {}));
  }

  const ip = clientIp(req);
  const target = `channel:${channelId}`;
  const guard = loginGuard.check(ip, target);
  if (guard.blocked) {
    return res
      .status(429)
      .type("text")
      .send(
        `Too many failed attempts — try again in about ${Math.max(1, Math.ceil(guard.retryAfterSec / 60))} minutes.`
      );
  }

  // scrypt is async but CPU-bound; the gate stops a flood of attempts from
  // pinning the event loop with parallel hashes.
  if (!(await loginGuard.acquireGate())) {
    return res.status(503).type("text").send("Server busy — please try again in a moment.");
  }
  let passwordOk;
  try {
    const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
    passwordOk = await verifyPasswordAsync(password, channel.passwordHash);
  } finally {
    loginGuard.releaseGate();
  }

  if (!passwordOk) {
    loginGuard.recordFailure(ip, target);
    await loginDelay();
    console.log(`[auth] Failed control login for "${channelId}" from ${ip}`);
    return res.redirect(`/c/${encodeURIComponent(channelId)}?error=1`);
  }

  loginGuard.recordSuccess(ip, target);
  setSession(res, req, controlCookieName(channelId), { channel: channelId }, SESSION_MAX_AGE);
  console.log(`[auth] Control login for "${channelId}" from ${ip}`);
  res.redirect(`/c/${encodeURIComponent(channelId)}`);
});

app.post("/c/:channelId/logout", (req, res) => {
  clearSession(res, req, controlCookieName(req.params.channelId));
  res.redirect(`/c/${encodeURIComponent(req.params.channelId)}`);
});

// =============================================================================
// Routes — view pages (OBS overlay, projector screen)
// =============================================================================

app.get("/v/:viewToken/:page", (req, res) => {
  const page = req.params.page.replace(/\.html$/, "");
  if (page !== "overlay" && page !== "screen") {
    return res.status(404).type("html").send(renderView("not-found", {}));
  }

  const channel = store.getChannelByViewToken(req.params.viewToken);
  if (!channel) {
    return res.status(404).type("html").send(renderView("not-found", {}));
  }

  // View pages are per-church URLs that should never be cached by an
  // intermediary, and never indexed.
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");

  sendView(res, page, {
    role: "view",
    channelId: channel.id,
    channelName: channel.name,
    wsUrl: `/ws?view=${encodeURIComponent(req.params.viewToken)}`,
  });
});

// Bare /v/<token> is a convenient thing to type on a projector machine.
app.get("/v/:viewToken", (req, res) => {
  res.redirect(`/v/${encodeURIComponent(req.params.viewToken)}/screen.html`);
});

// =============================================================================
// Routes — admin
// =============================================================================

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).type("text").send("Admin panel disabled: ADMIN_PASSWORD is not set.");
  }
  if (!isAdmin(req)) {
    if (req.path.startsWith("/admin/api/")) {
      return res.status(401).json({ error: "Not signed in" });
    }
    return sendView(res, "admin-login", { error: req.query.error === "1" ? "Incorrect password." : "" });
  }
  next();
}

app.post("/admin/login", async (req, res) => {
  if (!ADMIN_PASSWORD) {
    return res.status(503).type("text").send("Admin panel disabled: ADMIN_PASSWORD is not set.");
  }

  const ip = clientIp(req);
  const guard = loginGuard.check(ip, "admin");
  if (guard.blocked) {
    return res
      .status(429)
      .type("text")
      .send(
        `Too many failed attempts — try again in about ${Math.max(1, Math.ceil(guard.retryAfterSec / 60))} minutes.`
      );
  }

  const password = req.body && typeof req.body.password === "string" ? req.body.password : "";
  // Compare through the same constant-time path used for channel passwords by
  // padding both sides to equal length via HMAC-free comparison.
  if (!safeEqual(password, ADMIN_PASSWORD)) {
    loginGuard.recordFailure(ip, "admin");
    await loginDelay();
    console.log(`[auth] Failed admin login from ${ip}`);
    return res.redirect("/admin?error=1");
  }

  loginGuard.recordSuccess(ip, "admin");
  setSession(res, req, "tp_admin", { role: "admin" }, ADMIN_SESSION_MAX_AGE);
  console.log(`[auth] Admin login from ${ip}`);
  res.redirect("/admin");
});

app.post("/admin/logout", (req, res) => {
  clearSession(res, req, "tp_admin");
  res.redirect("/admin");
});

app.get("/admin", requireAdmin, (req, res) => {
  sendView(res, "admin", {});
});

app.get("/admin/api/channels", requireAdmin, (req, res) => {
  res.json({ channels: store.listChannels().map((c) => decorate(req, c)) });
});

app.post("/admin/api/channels", requireAdmin, (req, res) => {
  try {
    const channel = store.createChannel({
      id: String(req.body.id || "").trim().toLowerCase(),
      name: String(req.body.name || ""),
      password: String(req.body.password || ""),
    });
    console.log(`[admin] Created channel "${channel.id}"`);
    res.status(201).json({ channel: decorate(req, channel) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/admin/api/channels/:id/password", requireAdmin, (req, res) => {
  withChannel(req, res, () => {
    const channel = store.setPassword(req.params.id, String(req.body.password || ""));
    console.log(`[admin] Reset password for "${channel.id}"`);
    // Any existing operator sessions stay valid; that's intentional so a
    // password reset doesn't kick a live service off mid-sermon.
    res.json({ channel: decorate(req, channel) });
  });
});

app.post("/admin/api/channels/:id/rotate-token", requireAdmin, (req, res) => {
  withChannel(req, res, () => {
    const channel = store.rotateViewToken(req.params.id);
    // The old URL is dead now, so drop anyone still watching on it.
    disconnectViewers(channel.id);
    console.log(`[admin] Rotated view token for "${channel.id}"`);
    res.json({ channel: decorate(req, channel) });
  });
});

app.post("/admin/api/channels/:id/disabled", requireAdmin, (req, res) => {
  withChannel(req, res, () => {
    const channel = store.setDisabled(req.params.id, Boolean(req.body.disabled));
    if (channel.disabled) closeRoom(channel.id);
    console.log(`[admin] ${channel.disabled ? "Disabled" : "Enabled"} channel "${channel.id}"`);
    res.json({ channel: decorate(req, channel) });
  });
});

app.post("/admin/api/channels/:id/name", requireAdmin, (req, res) => {
  withChannel(req, res, () => {
    const channel = store.renameChannel(req.params.id, String(req.body.name || ""));
    res.json({ channel: decorate(req, channel) });
  });
});

app.delete("/admin/api/channels/:id", requireAdmin, (req, res) => {
  withChannel(req, res, () => {
    closeRoom(req.params.id);
    store.deleteChannel(req.params.id);
    console.log(`[admin] Deleted channel "${req.params.id}"`);
    res.json({ ok: true });
  });
});

// ---- Account requests --------------------------------------------------------

app.get("/admin/api/requests", requireAdmin, (req, res) => {
  res.json({ requests: requests.list() });
});

app.post("/admin/api/requests/:id/approve", requireAdmin, (req, res) => {
  try {
    const { request, channel, password } = requests.approve(req.params.id);
    console.log(`[admin] Approved request from "${request.churchName}" → channel "${channel.id}"`);
    // The password is returned exactly once; nothing is stored.
    res.json({ request, channel: decorate(req, channel), password });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/admin/api/requests/:id/dismiss", requireAdmin, (req, res) => {
  try {
    const request = requests.dismiss(req.params.id);
    console.log(`[admin] Dismissed request from "${request.churchName}"`);
    res.json({ request });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

function withChannel(req, res, fn) {
  try {
    fn();
  } catch (err) {
    const status = /No such channel/.test(err.message) ? 404 : 400;
    res.status(status).json({ error: err.message });
  }
}

/** Add live connection counts and ready-to-copy URLs for the admin table. */
function decorate(req, channel) {
  const room = rooms.get(channel.id);
  return {
    ...channel,
    controlUrl: absoluteUrl(req, `/c/${channel.id}`),
    overlayUrl: absoluteUrl(req, `/v/${channel.viewToken}/overlay.html`),
    screenUrl: absoluteUrl(req, `/v/${channel.viewToken}/screen.html`),
    connections: room ? room.sockets.size : 0,
  };
}

/**
 * Build an absolute URL for the church to copy. PUBLIC_URL wins when set,
 * which matters behind a tunnel: the request Host may be an internal name
 * while the church needs the public hostname.
 */
function absoluteUrl(req, pathname) {
  if (PUBLIC_URL) return `${PUBLIC_URL}${pathname}`;
  const proto = isSecureRequest(req) ? "https" : "http";
  return `${proto}://${req.get("host")}${pathname}`;
}

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

/** Constant-time string comparison that doesn't leak length via early exit. */
function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Fallbacks --------------------------------------------------------------

app.use((req, res) => {
  res.status(404).type("html").send(renderView("not-found", {}));
});

app.use((err, req, res, next) => {
  console.error(`[error] ${err.message}`);
  res.status(500).type("text").send("Internal Server Error");
});

// =============================================================================
// WebSocket server
// =============================================================================

const server = http.createServer(app);

// noServer + a manual upgrade handler lets us reject with a real HTTP status
// instead of completing the handshake and immediately closing.
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

/**
 * Live state per channel. `latest` is what a page receives the moment it
 * connects, so an OBS source that reloads mid-service comes back showing the
 * current verse instead of a blank bar.
 */
const rooms = new Map(); // channelId -> { latest, lastMessageAt, sockets:Set }

function getRoom(channelId) {
  let room = rooms.get(channelId);
  if (!room) {
    room = { latest: "", lastMessageAt: 0, sockets: new Set() };
    rooms.set(channelId, room);
  }
  return room;
}

function closeRoom(channelId) {
  const room = rooms.get(channelId);
  if (!room) return;
  for (const socket of room.sockets) socket.close(4404, "Channel unavailable");
  rooms.delete(channelId);
}

/**
 * Push a theme to everything watching a channel. This is what makes a design
 * change land on OBS and the projector without anyone reloading a source
 * mid-service.
 */
function broadcastTheme(channelId, value) {
  const room = rooms.get(channelId);
  if (!room) return;
  const payload = JSON.stringify({ type: "theme", theme: value });
  for (const socket of room.sockets) {
    if (socket.readyState === 1 /* OPEN */) socket.send(payload);
  }
}

function disconnectViewers(channelId) {
  const room = rooms.get(channelId);
  if (!room) return;
  for (const socket of room.sockets) {
    if (socket.tpRole === "view") socket.close(4401, "View link changed");
  }
}

// ---- Origin policy ----------------------------------------------------------

function isPrivateOrigin(origin) {
  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".local")) return true;
  // RFC 1918 ranges — the LAN case.
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

function isOriginAllowed(origin) {
  // OBS Browser Sources and other non-browser clients send no Origin header.
  // They still need a valid view token to get anywhere, so this is safe.
  if (!origin) return true;

  const normalized = origin.replace(/\/+$/, "");
  if (ALLOWED_ORIGINS.length === 0 && !PUBLIC_URL) return true; // dev default
  if (ALLOWED_ORIGINS.includes(normalized)) return true;
  if (PUBLIC_URL && normalized === PUBLIC_URL) return true;
  if (ALLOW_PRIVATE_ORIGINS && isPrivateOrigin(normalized)) return true;
  return false;
}

// ---- Upgrade handling (authenticate before the handshake) -------------------

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://placeholder");
  if (url.pathname !== "/ws") return rejectUpgrade(socket, 404, "Not Found");

  const origin = req.headers.origin || "";
  if (!isOriginAllowed(origin)) {
    console.log(`[security] Rejected WebSocket origin "${origin}"`);
    return rejectUpgrade(socket, 403, "Forbidden");
  }

  const viewToken = url.searchParams.get("view");
  const channelParam = url.searchParams.get("channel");

  let channel = null;
  let role = null;

  if (viewToken) {
    channel = store.getChannelByViewToken(viewToken);
    role = "view";
  } else if (channelParam) {
    channel = store.getChannel(channelParam);
    // The session cookie rides along on the handshake because the WebSocket
    // is same-origin, so the operator's password never touches client JS.
    if (channel && !channel.disabled && readControlSession(req, channel.id)) {
      role = "control";
    } else {
      channel = null;
    }
  }

  if (!channel || channel.disabled || !role) {
    return rejectUpgrade(socket, 401, "Unauthorized");
  }

  // Caps are checked here, before the handshake completes, so a flood of
  // connections is refused cheaply instead of being carried and dropped.
  if (wss.clients.size >= MAX_TOTAL_SOCKETS) {
    return rejectUpgrade(socket, 503, "Server at capacity");
  }
  const room = getRoom(channel.id);
  if (room.sockets.size >= MAX_SOCKETS_PER_CHANNEL) {
    return rejectUpgrade(socket, 503, "Channel at capacity");
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.tpChannelId = channel.id;
    ws.tpRole = role;
    wss.emit("connection", ws, req);
  });
});

function rejectUpgrade(socket, status, message) {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      "Connection: close\r\n" +
      "Content-Length: 0\r\n\r\n"
  );
  socket.destroy();
}

// ---- Connection handling ----------------------------------------------------

wss.on("connection", (socket, req) => {
  const channelId = socket.tpChannelId;
  const role = socket.tpRole;
  const room = getRoom(channelId);

  room.sockets.add(socket);
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  console.log(
    `[connect] ${role} joined "${channelId}" from ${clientIp(req)} ` +
      `(${room.sockets.size} on channel)`
  );

  // Theme first, so a page styles itself before any text appears — otherwise
  // a reconnecting overlay would flash the default design for a frame.
  socket.send(JSON.stringify({ type: "theme", theme: store.getTheme(channelId) }));

  // Then catch the page up to whatever is currently on screen.
  if (room.latest !== "") {
    socket.send(JSON.stringify({ type: "text", text: room.latest }));
  }

  socket.on("message", (data) => {
    // Read-only by design: a leaked overlay URL must never be able to
    // put text on another church's screen.
    if (role !== "control") {
      console.log(`[security] Dropped message from view socket on "${channelId}"`);
      return;
    }

    // Rate limit per channel, so a runaway control page can only ever
    // throttle its own church.
    const now = Date.now();
    if (now - room.lastMessageAt < MESSAGE_COOLDOWN_MS) return;
    room.lastMessageAt = now;

    // Control pages send {type:"text", text:"…"}. Anything else is ignored:
    // themes are saved over HTTP so they persist, not pushed over the socket.
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!message || message.type !== "text" || typeof message.text !== "string") return;

    room.latest = message.text;
    store.touchChannel(channelId);

    const payload = JSON.stringify({ type: "text", text: message.text });
    for (const client of room.sockets) {
      if (client.readyState === 1 /* OPEN */) client.send(payload);
    }
  });

  socket.on("close", () => {
    room.sockets.delete(socket);
    // Keep `latest` around: an empty room usually means the projector is
    // being moved, not that the service ended.
    console.log(`[disconnect] ${role} left "${channelId}" (${room.sockets.size} remain)`);
  });

  socket.on("error", (err) => {
    console.error(`[error] socket on "${channelId}": ${err.message}`);
  });
});

// A public server accumulates half-dead sockets behind NAT and sleeping
// laptops. Ping every 30 s and drop anything that stops answering.
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// Pick up channels edited by the CLI (or a restored backup) without a restart.
// A channel that disappears or is disabled on disk has its live sockets cut.
store.watch((count) => {
  console.log(`[store] channels.json changed — reloaded (${count} channels)`);
  for (const channelId of [...rooms.keys()]) {
    const channel = store.getChannel(channelId);
    if (!channel || channel.disabled) closeRoom(channelId);
  }
});

loginGuard.startCleanup();
requests.startCleanup();

// =============================================================================
// Start
// =============================================================================

server.listen(PORT, HOST, () => {
  const base = PUBLIC_URL || `http://localhost:${PORT}`;
  const channels = store.listChannels();

  console.log("");
  console.log("  TextPresenter — multi-channel server");
  console.log("  ────────────────────────────────────");
  console.log(`  Listening on   ${HOST}:${PORT}`);
  console.log(`  Public base    ${base}`);
  console.log(`  Admin panel    ${ADMIN_PASSWORD ? `${base}/admin` : "disabled (set ADMIN_PASSWORD)"}`);
  // Surfacing this makes "I set it in .env but nothing happened" self-diagnosing.
  console.log(
    `  From .env      ${loadedFromEnvFile.length ? loadedFromEnvFile.join(", ") : "nothing (no .env file, or all values already set in the environment)"}`
  );
  console.log(`  Data dir       ${store.DATA_DIR}`);
  console.log(`  Channels       ${channels.length}`);
  for (const channel of channels) {
    console.log(`    • ${channel.name}  →  ${base}/c/${channel.id}${channel.disabled ? "  (disabled)" : ""}`);
  }
  if (channels.length === 0) {
    console.log('    (none yet — add one in the admin panel, or:');
    console.log('     npm run channel -- add my-church "My Church")');
  }
  if (ALLOWED_ORIGINS.length === 0 && !PUBLIC_URL) {
    console.warn(
      "[security] ALLOWED_ORIGINS and PUBLIC_URL are both unset — any WebSocket\n" +
        "           origin is accepted (dev mode). Set them before going public:\n" +
        "           ALLOWED_ORIGINS=https://your-host"
    );
  }
  if (!PUBLIC_URL) {
    console.warn(
      "[security] PUBLIC_URL is not set — copy-paste links are built from the\n" +
        "           request's Host header, which a client can spoof. Set it for\n" +
        "           production so churches always get the real hostname."
    );
  }
  console.log("");
});

function shutdown(signal) {
  console.log(`\n[shutdown] ${signal} received — closing`);
  for (const socket of wss.clients) socket.close(1001, "Server shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
