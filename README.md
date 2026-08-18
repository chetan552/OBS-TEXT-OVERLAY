# TextPresenter

Real-time scripture and text overlays for **OBS Studio**, projectors and second screens. An operator types a reference on a control page; it appears instantly on every screen connected to that church's channel.

One server hosts **many churches**. Each gets its own channel, its own password, and its own private links — and never sees another church's text.

```
 Grace Fellowship                                    Hope Chapel
 ────────────────                                    ───────────
 control page ──┐                              ┌── control page
                │                              │
                ▼                              ▼
        ┌───────────────────────────────────────────────┐
        │  server: one room per channel, no crossover   │
        └───────────────────────────────────────────────┘
                │                              │
      ┌─────────┴─────────┐          ┌─────────┴─────────┐
      ▼                   ▼          ▼                   ▼
   OBS overlay        projector    OBS overlay        projector
```

## Channels and credentials

Each church is one **channel** with two separate credentials, because the two kinds of page have very different constraints:

| Page | Who opens it | URL | Credential |
|------|--------------|-----|------------|
| **Control** | Operator, on a laptop or phone | `/c/<channel-id>` | Password → session cookie, 30 days |
| **Overlay** | OBS Browser Source | `/v/<view-token>/overlay.html` | The token in the URL |
| **Screen** | Projector, second monitor | `/v/<view-token>/screen.html` | The token in the URL |

OBS can't fill in a login form, so overlay and screen pages authenticate by an unguessable 256-bit token in the URL instead. **Those view links are read-only** — the server drops any message from a view socket, so a leaked overlay URL lets someone watch a church's text but never put text on their screen. Rotating the token invalidates the old links immediately.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later

## Quick start (local)

```bash
npm install

# Configure — at minimum, set ADMIN_PASSWORD
cp .env.example .env
$EDITOR .env

npm start
```

Then open `http://localhost:3000/admin` and add your first church.

The startup banner reports which variables came from `.env`:

```
  Admin panel    http://localhost:3000/admin
  From .env      ADMIN_PASSWORD, PORT
  Data dir       /path/to/data
```

If a setting doesn't seem to apply, check that line first. **Real environment variables take precedence over `.env`** — so a value already exported in your shell, or set by launchd or Render, wins and won't appear in that list. You can also skip the file entirely:

```bash
ADMIN_PASSWORD=some-long-admin-password npm start
```

## Quick start (Docker)

No Node required on the host — Docker and Docker Compose are enough.

```bash
cp .env.example .env
$EDITOR .env   # at minimum, set ADMIN_PASSWORD

docker compose up -d --build
```

Then open `http://localhost:3000/admin`. Compose reads the same `.env` for
both port mapping and container configuration, and keeps channel data in a
named volume (`textpresenter-data`) so it survives container rebuilds.

| Task | Command |
|------|---------|
| Follow the logs (startup banner included) | `docker compose logs -f` |
| Manage channels from the CLI | `docker compose exec textpresenter npm run channel -- list` |
| Check it's alive | `curl http://localhost:3000/healthz` |
| Stop | `docker compose down` |
| Stop and wipe the channel data | `docker compose down -v` |

Two container-specific notes:

- **`HOST` is pinned to `0.0.0.0` in `docker-compose.yml`** and the value in
  `.env` is ignored. Inside a container, `HOST=127.0.0.1` (the tunnel-only
  setting) would make the published port unreachable.
- **Bind mounts instead of the named volume:** replace
  `textpresenter-data:/data` with `./data:/data` and run
  `mkdir -p data && chown 1000:1000 data` first — the app runs as uid 1000
  inside the container and can't write a host-owned directory.

---

# Hosting for multiple churches

## 1. Prepare the Mac mini

```bash
bash deploy/setup-macmini.sh
```

This disables system and disk sleep (a sleeping mini drops every church mid-service), enables auto-restart after a power cut, and creates the data directory.

Then put the code somewhere stable and outside your home directory:

```bash
sudo mkdir -p /Users/Shared/textpresenter
sudo chown "$(whoami)" /Users/Shared/textpresenter
git clone <this-repo> /Users/Shared/textpresenter
cd /Users/Shared/textpresenter && npm install --omit=dev
```

## 2. Run it as a service

`deploy/org.textpresenter.server.plist` is a launchd **daemon**, so the server starts at boot and keeps running with nobody logged in.

Edit it first — the node path, the install path, your account name, `ADMIN_PASSWORD` and `PUBLIC_URL` — then:

```bash
sudo cp deploy/org.textpresenter.server.plist /Library/LaunchDaemons/
sudo chown root:wheel /Library/LaunchDaemons/org.textpresenter.server.plist
sudo chmod 644 /Library/LaunchDaemons/org.textpresenter.server.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/org.textpresenter.server.plist

tail -f /var/log/textpresenter.log
```

| Task | Command |
|------|---------|
| Restart after a code change | `sudo launchctl kickstart -k system/org.textpresenter.server` |
| Stop and uninstall | `sudo launchctl bootout system/org.textpresenter.server` |
| Check it's alive | `curl http://localhost:3000/healthz` |

## 3. Publish it with a Cloudflare Tunnel

```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create textpresenter
cloudflared tunnel route dns textpresenter text.example.org

cp deploy/cloudflared-config.example.yml ~/.cloudflared/config.yml
# edit the tunnel UUID and hostname, then:
sudo cloudflared service install
```

Nothing listens on your public IP — cloudflared dials **out** to Cloudflare, which routes your hostname back down the tunnel. No port forwarding, no static IP, works behind CGNAT, and HTTPS/WSS is handled at the edge.

Verify with `curl https://text.example.org/healthz`.

## 4. Lock down origins

Once you're public, set these (in the plist's `EnvironmentVariables`):

```
PUBLIC_URL=https://text.example.org
ALLOWED_ORIGINS=https://text.example.org
ALLOW_PRIVATE_ORIGINS=true
```

`ALLOW_PRIVATE_ORIGINS` additionally permits LAN and localhost origins, which is what lets your own church's OBS and projector connect straight to the mini over the network — no internet dependency mid-service — while other churches come in through the tunnel.

`PUBLIC_URL` matters behind a tunnel: the request's `Host` header is internal, so without it the copy-paste links shown to churches would be wrong.

---

# Administration

## The admin panel

`https://text.example.org/admin`, gated by `ADMIN_PASSWORD`. If that variable isn't set the panel is disabled entirely and refuses to serve.

From there you can:

- **Add a church** — name, channel id, operator password. The panel generates a readable password (`cedar-harbor-418`) since someone usually reads it aloud to a volunteer.
- **Copy the three links** to send to that church.
- **Reset password** — for when a volunteer moves on. Existing signed-in sessions keep working, so this never interrupts a live service.
- **Rotate links** — issues a new view token. The old overlay and screen URLs stop working immediately and anyone watching on them is disconnected. This is the lever for a leaked link.
- **Disable / enable** — takes a channel offline without deleting it.
- **Delete** — permanent, requires typing the channel id.

The panel also shows live connection counts per channel, so you can see who's actually on air.

## The CLI

For bootstrapping over SSH, scripting onboarding, or recovering a lost `ADMIN_PASSWORD`:

```bash
npm run channel -- list
npm run channel -- add grace-fellowship "Grace Fellowship" [password]
npm run channel -- password grace-fellowship [password]
npm run channel -- rotate grace-fellowship
npm run channel -- disable grace-fellowship
npm run channel -- enable grace-fellowship
npm run channel -- remove grace-fellowship
```

A running server watches `channels.json` and picks up CLI changes within a couple of seconds — no restart needed.

## Designing the look

Each church designs its own overlay and screen at **`/c/<channel>/design`** — linked from the control page as *Customize design*. It's their screen, and routing every tweak through an admin would make the feature unusable in practice. A church can only ever restyle its own channel.

The page puts controls on the left and a live preview on the right. The previews aren't approximations: they're real 1920×1080 canvases running the same markup and the same theme code (`public/theme-apply.js`) as the actual pages, scaled to fit. What you see is what OBS shows.

**Saving applies instantly.** The new theme is pushed down the same WebSocket the text uses, so a connected OBS Browser Source and projector restyle themselves without anyone touching a source mid-service.

| | Adjustable |
|---|---|
| **Overlay** | Font, size, weight, color, capitalization, letter spacing; bar color, opacity, height, max width, padding, angled edge, corner radius; anchor side, vertical position, offsets; animation style and speed |
| **Screen** | Font, size, weight, color, capitalization, letter spacing, line height; background, edge padding, horizontal and vertical alignment; fade speed |

15 fonts are available (Lato, PT Sans Narrow, Oswald, Bebas Neue, Montserrat, Playfair Display, EB Garamond and others, plus system stacks). They load from Google Fonts on demand.

**Reset to default** comes in two forms: *Reset this tab* restores just the overlay or just the screen, *Reset all* restores both. Either way the result is exactly the original shipped design — the defaults in `lib/theme.js` are that design value for value, and a smoke-test check asserts a reset matches it byte for byte.

New channels start on the default design, so nothing changes for a church that never opens the page.

### Adding a new adjustable property

Add it to `OVERLAY_FIELDS` or `SCREEN_FIELDS` in `lib/theme.js`, then consume the matching CSS variable in the page. The design page builds its controls from that schema, so the slider or dropdown appears on its own — the only manual step is listing the key in the relevant `GROUPS` entry in `views/design.html` so it lands under the right heading.

## Onboarding a church

1. Create the channel in the admin panel.
2. Send them the **control link** and the **operator password** — for the person running the service.
3. Send them the **overlay link** — they add it in OBS as a *Browser Source*, 1920×1080, "Refresh browser when scene becomes active".
4. Send them the **screen link** if they use a projector or second monitor.
5. Tell them the overlay and screen links are secrets. Anyone with one can watch their text.

## Backups

Everything durable lives in `DATA_DIR` (default `data/`, or `/Users/Shared/textpresenter-data` in the plist):

| File | Contents |
|------|----------|
| `channels.json` | Channel list, scrypt password hashes, view tokens, per-channel themes |
| `session-secret` | HMAC key for session cookies |

Back that directory up off the machine. Losing `channels.json` means re-creating every channel and reissuing every link; losing `session-secret` just signs everyone out.

It's gitignored — never commit it.

---

# Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ADMIN_PASSWORD` | *(unset)* | Password for `/admin`. Unset disables the panel. |
| `PUBLIC_URL` | *(derived from Host)* | Public base URL. Required behind a tunnel or reverse proxy. |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind. `127.0.0.1` for tunnel-only. |
| `ALLOWED_ORIGINS` | *(all)* | Comma-separated exact origins allowed to open a WebSocket |
| `ALLOW_PRIVATE_ORIGINS` | `true` | Also allow LAN / localhost / `.local` origins |
| `DATA_DIR` | `./data` | Where `channels.json` and `session-secret` live |
| `SESSION_SECRET` | *(generated)* | Cookie signing key. Set only to move sessions between machines. |

See `.env.example`.

---

# Security model

**Isolation.** Every socket is bound to exactly one channel during the WebSocket handshake, before the connection is accepted. Broadcasts iterate that channel's socket set only. Rate limiting is per channel, so one church's runaway page can only ever throttle itself.

**View links are read-only.** The server drops any message arriving on a view socket. A leaked overlay URL cannot write to a screen.

**Auth happens before the handshake.** Unauthorized upgrades get an HTTP 401 and the socket is destroyed — the connection is never established.

**Operator credentials never touch client JS.** The session cookie is `HttpOnly` and rides along on the same-origin WebSocket handshake automatically.

**Passwords** are scrypt-hashed with a per-password salt (N=16384) and compared in constant time. Failed logins pause ~400 ms.

**Sessions** are stateless HMAC-SHA256 tokens with an embedded expiry — 30 days for operators, 12 hours for admin.

**Pages aren't statically served.** `views/` sits outside the static directory, so `/control.html` and `/overlay.html` 404 rather than bypassing auth. Only the assets in `public/` (the stylesheet and the theme script) are served directly.

**Themes are validated, not filtered.** A saved theme becomes CSS custom properties, so `lib/theme.js` treats it as untrusted input against a whitelist: unknown keys are dropped, colors must match `#rrggbb`, fonts and enums must be members of a fixed list, and numbers are clamped to a range. Nothing a user types can reach a page as arbitrary CSS. The smoke test asserts this with hostile input.

**Other.** 64 KiB message cap enforced at the protocol level; origin validation on upgrade; 30-second heartbeat that terminates unresponsive sockets; `nosniff`, `X-Frame-Options`, `Referrer-Policy` and a CSP on every response; all client pages render text with `textContent`, never `innerHTML`.

Run `npm run smoke` to verify the isolation properties — it boots a real server, creates two channels, and asserts that text doesn't cross between them, that view sockets can't broadcast, and that unauthenticated sockets are refused.

---

# Files

| Path | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server, routing, channel rooms |
| `lib/store.js` | Channel persistence (`channels.json`) |
| `lib/auth.js` | scrypt hashing, signed session cookies |
| `lib/theme.js` | Theme schema, defaults (= the original design), validation |
| `lib/env.js` | `.env` loader |
| `views/control.html` | Operator page — text input, autocomplete, history |
| `views/overlay.html` | OBS-ready transparent overlay |
| `views/screen.html` | Full-screen projector display |
| `views/design.html` | Appearance editor with live preview |
| `views/admin.html` | Channel management panel |
| `views/login.html` | Channel sign-in |
| `public/style.css` | Shared styles |
| `public/theme-apply.js` | Turns a theme into CSS variables (shared by the pages and the preview) |
| `scripts/channel.js` | Channel admin CLI |
| `scripts/smoke-test.js` | Isolation and auth checks |
| `deploy/` | launchd service, Cloudflare Tunnel config, host setup |

## License

MIT
