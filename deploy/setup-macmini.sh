#!/usr/bin/env bash
# =============================================================================
# Mac mini host preparation
# =============================================================================
# Configures the power and sleep settings a machine needs to serve reliably,
# and creates the data directory. Run once, before installing the launchd
# service. Everything here is reversible and printed before it runs.
#
#   bash deploy/setup-macmini.sh
#
# It does NOT install the service or the tunnel — see the README for those,
# since both need values only you can supply.

set -euo pipefail

DATA_DIR="${DATA_DIR:-/Users/Shared/textpresenter-data}"

echo "TextPresenter — Mac mini host setup"
echo "==================================="
echo

# ---- Power settings ---------------------------------------------------------
# A sleeping Mac mini drops every church's connection. Disabling system and
# disk sleep is the single most important thing for uptime. Display sleep is
# left alone — the screen can and should turn off.
echo "The following will be applied (requires sudo):"
echo "  pmset -a sleep 0          # never sleep the system"
echo "  pmset -a disksleep 0      # never spin down the disk"
echo "  pmset -a womp 1           # wake for network access"
echo "  pmset -a autorestart 1    # restart automatically after a power failure"
echo

read -r -p "Apply these power settings? [y/N] " reply
if [[ "$reply" =~ ^[Yy]$ ]]; then
  sudo pmset -a sleep 0
  sudo pmset -a disksleep 0
  sudo pmset -a womp 1
  sudo pmset -a autorestart 1
  echo "  Applied."
else
  echo "  Skipped. The server will drop connections whenever the mini sleeps."
fi
echo

# ---- Data directory ---------------------------------------------------------
# Kept outside the git checkout so a `git pull` or a re-clone can never
# destroy the channel list.
echo "Data directory: $DATA_DIR"
if [[ -d "$DATA_DIR" ]]; then
  echo "  Already exists — leaving it alone."
else
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  echo "  Created."
fi
echo

# ---- Report -----------------------------------------------------------------
echo "Current power settings:"
pmset -g custom | sed 's/^/  /'
echo

echo "Node: $(command -v node || echo 'NOT FOUND — install with: brew install node')"
if command -v node > /dev/null; then
  echo "  version $(node --version)   (use this path in the launchd plist)"
fi
echo
echo "LAN address: $(ipconfig getifaddr en0 2>/dev/null || echo 'not on en0')"
echo
echo "Next steps:"
echo "  1. Edit deploy/org.textpresenter.server.plist (paths, ADMIN_PASSWORD, PUBLIC_URL)"
echo "  2. Install it — see the README's 'Running as a service' section"
echo "  3. Set up the Cloudflare Tunnel — see deploy/cloudflared-config.example.yml"
echo "  4. Back up $DATA_DIR somewhere off the machine"
