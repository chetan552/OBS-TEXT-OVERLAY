# TextPresenter

A real-time WebSocket-powered text overlay for **OBS Studio**, live streaming, presentations, and second-screen displays. Type text on a control page, and it instantly appears on every connected overlay or screen page.

## How it works

```
 Control page          Server              Overlay (OBS) / Screen page
 ─────────────         ──────              ────────────────────────────
 Type text ──────────► WS msg ────────────► Text appears live
                       stores
                       latest
                       message
```

- The **control page** (`control.html`) is where you type and send text.
- The **server** (`server.js`) relays messages over WebSockets and keeps the latest message in memory.
- The **overlay page** (`overlay.html`) is meant to be added as an OBS Browser Source for streaming.
- The **screen page** (`screen.html`) is a full-window display for projectors or second monitors.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later

## Quick start

```bash
# 1. Navigate to the project
cd obs-text-overlay

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

The server starts on **port 3000** by default. You'll see:

```
╔═══════════════════════════════════════════════════════════════╗
║         OBS Text Overlay Server                               ║
╠═══════════════════════════════════════════════════════════════╣
║  Control:   http://localhost:3000/control.html                ║
║  Overlay:   http://localhost:3000/overlay.html   (OBS)        ║
║  Screen:    http://localhost:3000/screen.html    (display)    ║
╚═══════════════════════════════════════════════════════════════╝
```

## Usage

### 1. Open the control page

Go to [http://localhost:3000/control.html](http://localhost:3000/control.html) — type your text and press Enter to send it live.

### 2. Open the overlay or screen page

- **Overlay** → [http://localhost:3000/overlay.html](http://localhost:3000/overlay.html) — designed for OBS transparency (add as a 1920×1080 Browser Source).
- **Screen** → [http://localhost:3000/screen.html](http://localhost:3000/screen.html) — full-window view for projectors and second monitors.

Both pages update instantly when text is sent from the control page. They also show the last sent message if refreshed mid-session.

### OBS Studio setup

1. In OBS, add a new **Browser** source.
2. Set the URL to `http://localhost:3000/overlay.html`.
3. Set the resolution to **1920×1080**.
4. Check **Refresh browser when scene becomes active**.
5. Position and size the overlay as needed.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |
| `HOST` | `0.0.0.0` | Network interface to bind to |

Examples:

```bash
# Use a different port
PORT=3001 npm start

# Bind to localhost only (not accessible from other devices)
HOST=127.0.0.1 npm start

# Expose on all network interfaces (default — accessible from phones, tablets, other PCs)
HOST=0.0.0.0 npm start
```

When bound to `0.0.0.0`, other devices on your network can reach the server at `http://<your-ip>:3000/`. Find your local IP with:

```bash
# macOS
ipconfig getifaddr en0

# Linux
hostname -I | awk '{print $1}'

# Windows
ipconfig | findstr /i "IPv4"
```

## Files

| File | Purpose |
|------|---------|
| `server.js` | Express + WebSocket server |
| `public/control.html` | Text input and send controls |
| `public/overlay.html` | OBS-ready transparent overlay |
| `public/screen.html` | Full-screen display page |
| `public/style.css` | Shared styles |

## License

MIT
