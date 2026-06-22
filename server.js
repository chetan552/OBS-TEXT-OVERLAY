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
// HOST=127.0.0.1 for local-only, HOST=0.0.0.0 to expose on the network

// ---- Express app (serves static files) --------------------------------------
const app = express();
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// ---- HTTP server (Express + WebSocket share the same port) ------------------
const server = http.createServer(app);

// ---- WebSocket server -------------------------------------------------------
const wss = new WebSocketServer({ server });

// We keep the most recent message in memory so that when a new overlay
// client connects, it can immediately show the current text.
let latestMessage = "";

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

// ---- WebSocket connection handling ------------------------------------------
wss.on("connection", (socket, req) => {
  const clientIp =
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  console.log(`[connect] Client connected from ${clientIp}`);

  // Immediately send the latest message so the overlay shows the current
  // text even if the page was just refreshed.
  if (latestMessage !== "") {
    socket.send(latestMessage);
  }

  // When this client sends a message, update latestMessage and broadcast
  // it to every OTHER client as well.
  socket.on("message", (data) => {
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
