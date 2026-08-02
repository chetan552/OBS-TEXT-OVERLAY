#!/usr/bin/env node
// =============================================================================
// Smoke test — proves channels are actually isolated
// =============================================================================
// Boots the real server against a throwaway data directory, creates two
// channels, and checks the properties that matter for hosting several
// churches on one box:
//
//   1. Text sent on channel A never reaches channel B.
//   2. A view socket (OBS / projector) cannot send text.
//   3. A control socket without a valid session is refused.
//   4. A wrong password does not produce a session.
//   5. The overlay/control HTML can't be fetched without a credential.
//
// Run with:  npm run smoke

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "textpresenter-smoke-"));
const ADMIN_PASSWORD = "smoke-admin-password";

const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  DATA_DIR,
  ADMIN_PASSWORD,
  SESSION_SECRET: "smoke-test-secret",
};

let failures = 0;
let server;

function check(label, condition) {
  console.log(`${condition ? "  ok  " : "  FAIL"}  ${label}`);
  if (!condition) failures++;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Helpers ----------------------------------------------------------------

/** Create a channel through the CLI so the store code path is exercised too. */
function createChannel(id, name, password) {
  const result = require("child_process").spawnSync(
    process.execPath,
    [path.join(__dirname, "channel.js"), "add", id, name, password],
    { env, encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  const match = result.stdout.match(/\/v\/([^/]+)\/overlay\.html/);
  return { id, viewToken: match[1] };
}

/** Log in to a channel and return its session cookie. */
async function login(channelId, password) {
  const res = await fetch(`${BASE}/c/${channelId}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") || "";
  return setCookie.split(";")[0];
}

/**
 * Open a socket and collect every message it receives, split by envelope
 * type so a test can assert on text without tripping over theme pushes.
 */
function openSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    const texts = [];
    const themes = [];
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (message.type === "text") texts.push(message.text);
      if (message.type === "theme") themes.push(message.theme);
    });
    socket.on("open", () => resolve({ socket, texts, themes }));
    socket.on("error", reject);
    socket.on("unexpected-response", (_req, res) =>
      reject(new Error(`HTTP ${res.statusCode}`))
    );
  });
}

const sendText = (entry, text) => entry.socket.send(JSON.stringify({ type: "text", text }));

/** Resolve true if the socket is refused (which is the pass condition). */
async function expectRefused(url, options) {
  try {
    const { socket } = await openSocket(url, options);
    socket.close();
    return false;
  } catch {
    return true;
  }
}

// ---- Test run ---------------------------------------------------------------

async function run() {
  const grace = createChannel("grace-test", "Grace Test", "grace-password-1");
  const hope = createChannel("hope-test", "Hope Test", "hope-password-1");

  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  // Wait for the port to accept connections.
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${BASE}/healthz`);
      break;
    } catch {
      await wait(100);
    }
  }

  const graceCookie = await login("grace-test", "grace-password-1");
  const hopeCookie = await login("hope-test", "hope-password-1");

  check("operator login returns a session cookie", graceCookie.startsWith("tp_c_grace_test="));

  // ---- 1. Cross-channel isolation ------------------------------------------
  const graceControl = await openSocket(`ws://127.0.0.1:${PORT}/ws?channel=grace-test`, {
    headers: { Cookie: graceCookie },
  });
  const graceView = await openSocket(`ws://127.0.0.1:${PORT}/ws?view=${grace.viewToken}`);
  const hopeView = await openSocket(`ws://127.0.0.1:${PORT}/ws?view=${hope.viewToken}`);

  sendText(graceControl, "John 3:16");
  await wait(250);

  check("text reaches its own channel's overlay", graceView.texts.includes("John 3:16"));
  check("text does NOT reach another channel's overlay", hopeView.texts.length === 0);

  // ---- 2. View sockets are read-only ---------------------------------------
  sendText(hopeView, "hijacked");
  await wait(250);
  check("view socket cannot broadcast", !hopeView.texts.includes("hijacked"));

  // ---- 3 & 4. Control auth --------------------------------------------------
  check(
    "control socket without a cookie is refused",
    await expectRefused(`ws://127.0.0.1:${PORT}/ws?channel=grace-test`)
  );
  check(
    "control socket with another channel's cookie is refused",
    await expectRefused(`ws://127.0.0.1:${PORT}/ws?channel=grace-test`, {
      headers: { Cookie: hopeCookie },
    })
  );
  check(
    "unknown view token is refused",
    await expectRefused(`ws://127.0.0.1:${PORT}/ws?view=not-a-real-token`)
  );
  check("wrong password grants no session", (await login("grace-test", "wrong")) === "");

  // ---- 5. Pages can't be fetched without a credential ----------------------
  const staticControl = await fetch(`${BASE}/control.html`);
  const staticOverlay = await fetch(`${BASE}/overlay.html`);
  check("/control.html is not directly reachable", staticControl.status === 404);
  check("/overlay.html is not directly reachable", staticOverlay.status === 404);

  const loginPage = await fetch(`${BASE}/c/grace-test`);
  check("control page shows a login when signed out", (await loginPage.text()).includes("Sign in"));

  const controlPage = await fetch(`${BASE}/c/grace-test`, { headers: { Cookie: graceCookie } });
  const controlHtml = await controlPage.text();
  check("signed-in control page loads", controlHtml.includes("historyList"));
  check(
    "control page carries its own view token, not another channel's",
    controlHtml.includes(grace.viewToken) && !controlHtml.includes(hope.viewToken)
  );

  const adminPage = await fetch(`${BASE}/admin`);
  check("admin panel requires a password", (await adminPage.text()).includes("Admin password"));

  // ---- 6. Theming ----------------------------------------------------------
  const defaults = require("../lib/theme").defaultTheme();

  check("a page is themed the moment it connects", graceView.themes.length === 1);
  check(
    "a new channel starts on the original design",
    JSON.stringify(graceView.themes[0]) === JSON.stringify(defaults)
  );

  // Save a theme and confirm it lands live on the already-connected pages.
  const saveRes = await fetch(`${BASE}/c/grace-test/api/theme`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: graceCookie },
    body: JSON.stringify({
      overlay: { barColor: "#ff0000", fontSize: 72, side: "right" },
      screen: { backgroundColor: "#101010", textTransform: "none" },
    }),
  });
  const saved = (await saveRes.json()).theme;
  await wait(250);

  check("theme saves", saveRes.status === 200 && saved.overlay.barColor === "#ff0000");
  check("theme pushes live to the overlay", graceView.themes.length === 2);
  check(
    "the pushed theme is the one that was saved",
    graceView.themes[1].overlay.barColor === "#ff0000" &&
      graceView.themes[1].overlay.side === "right"
  );
  check("another channel's theme is untouched", hopeView.themes.length === 1);

  // Unspecified keys must fall back to the default rather than vanishing.
  check(
    "omitted properties fall back to the default",
    saved.overlay.barHeight === defaults.overlay.barHeight &&
      saved.screen.fontSize === defaults.screen.fontSize
  );

  // ---- Validation: this is user input that becomes CSS ---------------------
  const hostile = await fetch(`${BASE}/c/grace-test/api/theme`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: graceCookie },
    body: JSON.stringify({
      overlay: {
        barColor: "red; background: url(javascript:alert(1))",
        fontFamily: "'; } body { display: none } .x {",
        fontSize: 99999,
        side: "../../etc/passwd",
        textTransform: "expression(alert(1))",
      },
      screen: { padding: -500, fontSize: "NaN" },
      __proto__: { polluted: true },
    }),
  });
  const cleaned = (await hostile.json()).theme;

  check("invalid color is rejected", cleaned.overlay.barColor === defaults.overlay.barColor);
  check("invalid font is rejected", cleaned.overlay.fontFamily === defaults.overlay.fontFamily);
  check("invalid enum is rejected", cleaned.overlay.side === defaults.overlay.side);
  check("invalid transform is rejected", cleaned.overlay.textTransform === defaults.overlay.textTransform);
  check("out-of-range number is clamped, not passed through", cleaned.overlay.fontSize === 160);
  check("negative number is clamped to the minimum", cleaned.screen.padding === 0);
  check("non-numeric number falls back to the default", cleaned.screen.fontSize === defaults.screen.fontSize);
  check("no unknown keys survive", !("polluted" in cleaned) && !("polluted" in cleaned.overlay));

  // ---- Reset ---------------------------------------------------------------
  const resetRes = await fetch(`${BASE}/c/grace-test/api/theme/reset`, {
    method: "POST",
    headers: { Cookie: graceCookie },
  });
  const resetTheme = (await resetRes.json()).theme;
  check(
    "reset restores the original design exactly",
    JSON.stringify(resetTheme) === JSON.stringify(defaults)
  );

  // ---- Theme editing is operator-only --------------------------------------
  const noAuth = await fetch(`${BASE}/c/grace-test/api/theme`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(defaults),
  });
  check("theme cannot be changed without a session", noAuth.status === 401);

  const crossAuth = await fetch(`${BASE}/c/grace-test/api/theme`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: hopeCookie },
    body: JSON.stringify(defaults),
  });
  check("one channel cannot restyle another", crossAuth.status === 401);

  const designPage = await fetch(`${BASE}/c/grace-test/design`, {
    headers: { Cookie: graceCookie },
  });
  check("design page loads for a signed-in operator", (await designPage.text()).includes("overlayStage"));

  const designNoAuth = await fetch(`${BASE}/c/grace-test/design`, { redirect: "manual" });
  check("design page redirects when signed out", designNoAuth.status === 302);

  // ---- 7. CLI edits reach the running server -------------------------------
  // The reset above was a server-side write. A CLI edit landing right after
  // it must still be picked up: an earlier version suppressed any change
  // within 3 s of our own save, and because fs.watchFile only reports
  // transitions, that edit was then lost for good.
  createChannel("late-test", "Late Test", "late-password-1");
  for (let attempt = 0; attempt < 30; attempt++) {
    const health = await (await fetch(`${BASE}/healthz`)).json();
    if (health.channels === 3) break;
    await wait(500);
  }
  const health = await (await fetch(`${BASE}/healthz`)).json();
  check("a channel added by the CLI reaches the running server", health.channels === 3);

  for (const entry of [graceControl, graceView, hopeView]) entry.socket.close();
}

run()
  .catch((err) => {
    console.error(`\nSmoke test crashed: ${err.stack}`);
    failures++;
  })
  .finally(async () => {
    if (server) server.kill("SIGTERM");
    await wait(300);
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
    process.exit(failures === 0 ? 0 : 1);
  });
