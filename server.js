// =============================================================================
// OBS Text Overlay — WebSocket Server
// =============================================================================
// This server does three things:
//   1. Serves static files (control.html, overlay.html, style.css) from /public
//   2. Hosts a WebSocket server that receives text from the control page
//   3. Broadcasts that text to every connected overlay page
//
// The latest message is kept in memory so when an overlay page refreshes
// (or reconnects), it immediately receives the current text.

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");

// ---- Configuration ----------------------------------------------------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KiB — more than enough for display text

// Allowed WebSocket origins (empty = allow all, common for local-only tools)
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : []; // Default: allow all origins (safe for localhost/LAN)

// ---- Express app (serves static files) --------------------------------------
const app = express();

// ---- Security headers -------------------------------------------------------
app.use((req, res, next) => {
  // Prevent MIME-type sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Prevent clickjacking (overlay/screen pages shouldn't be framed elsewhere)
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  // Basic CSP: only allow fonts from Google Fonts, everything else same-origin
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; font-src 'self' https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:;"
  );

  next();
});

// ---- Serve static files -----------------------------------------------------
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// ---- Hide Express default error stack traces --------------------------------
// Don't leak internals — send a generic error response instead.
app.use((err, req, res, next) => {
  console.error(`[error] ${err.message}`);
  res.status(500).send("Internal Server Error");
});

// ---- HTTP server (Express + WebSocket share the same port) ------------------
const server = http.createServer(app);

// ---- WebSocket server -------------------------------------------------------
const wss = new WebSocketServer({ server });

// We keep the most recent message in memory so that when a new overlay
// client connects, it can immediately show the current text.
let latestMessage = "";

// ---- Helper: validate WebSocket origin --------------------------------------
function isOriginAllowed(origin) {
  // No origin = same-origin request (browser doesn't send Origin for ws://
  // to the same host). Always allow these.
  if (!origin) return true;

  // If no allowed origins are configured, allow everything (default).
  if (ALLOWED_ORIGINS.length === 0) return true;

  return ALLOWED_ORIGINS.some(
    (allowed) => origin === allowed || origin.startsWith(allowed)
  );
}

// ---- Helper: broadcast a message to every connected client ------------------
function broadcast(data, senderSocket) {
  const payload = typeof data === "string" ? data : data.toString();
  wss.clients.forEach((client) => {
    // Only send to clients that are still connected and ready
    if (client.readyState === 1 /* WebSocket.OPEN */) {
      client.send(payload);
    }
  });
}

// ---- Rate limiter: per-IP message throttle ----------------------------------
// Simple token-bucket: each IP gets one message per 200 ms (5/sec).
// This is per-connection, not shared across connections from the same IP —
// adequate for the threat model of a local-only tool.
const lastMessageTime = new Map();

function isRateLimited(socket, req) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  const now = Date.now();
  const last = lastMessageTime.get(ip) || 0;
  const cooldown = 200; // ms between messages from the same IP

  if (now - last < cooldown) {
    return true;
  }
  lastMessageTime.set(ip, now);
  return false;
}

// Periodically clean up the rate-limit map so it doesn't leak memory
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamp] of lastMessageTime) {
    if (now - timestamp > 60_000) {
      lastMessageTime.delete(ip);
    }
  }
}, 60_000);

// ---- WebSocket connection handling ------------------------------------------
wss.on("connection", (socket, req) => {
  const clientIp =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const origin = req.headers["origin"] || "";

  // ---- Origin check ---------------------------------------------------------
  if (!isOriginAllowed(origin)) {
    console.log(
      `[security] Rejected WebSocket from origin "${origin}" (${clientIp})`
    );
    socket.close(4403, "Origin not allowed");
    return;
  }

  console.log(`[connect] Client connected from ${clientIp}`);

  // Immediately send the latest message so the overlay shows the current
  // text even if the page was just refreshed.
  if (latestMessage !== "") {
    socket.send(latestMessage);
  }

  // When this client sends a message, validate, rate-limit, update
  // latestMessage, and broadcast.
  socket.on("message", (data) => {
    // ---- Size limit ----------------------------------------------------------
    if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) {
      console.log(
        `[security] Rejected oversized message (${Buffer.byteLength(data)} bytes) from ${clientIp}`
      );
      return;
    }

    // ---- Rate limit ----------------------------------------------------------
    if (isRateLimited(socket, req)) {
      console.log(`[security] Rate-limited message from ${clientIp}`);
      return;
    }

    const text = data.toString();
    console.log(`[message] Received: "${text}"`);
    latestMessage = text;
    broadcast(text);
  });

  // Log disconnections
  socket.on("close", (code, reason) => {
    console.log(`[disconnect] Client disconnected (code: ${code})`);
  });

  // Log errors
  socket.on("error", (err) => {
    console.error(`[error] ${err.message}`);
  });
});

// ---- Start the server -------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║         OBS Text Overlay Server                           ║");
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log(`║  Control:   http://localhost:${PORT}/control.html            ║`);
  console.log(`║  Overlay:   http://localhost:${PORT}/overlay.html   (OBS)    ║`);
  console.log(`║  Screen:    http://localhost:${PORT}/screen.html    (display) ║`);
  console.log("╠═══════════════════════════════════════════════════════════╣");
  console.log(`║  Bound to ${HOST}:${PORT}                                         ║`);
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("Control — type text and press Enter to send.");
  console.log("Overlay — add as an OBS Browser Source (1920×1080).");
  console.log("Screen  — open on a second monitor / projector.");
  console.log("");
});
