#!/usr/bin/env bash
# Headless StarNet station on an Oracle Cloud VM (Ubuntu or Oracle Linux, x86_64 or Ampere ARM64).
# Run from the repo checkout ON THE VM:  bash deploy/oracle-vm/setup.sh
# Installs Node 22 + native build tools, runs `npm ci`, and installs a systemd unit that keeps the
# sidecar up on 127.0.0.1:8787. It opens NO ports: reach the station through an SSH tunnel (see README.md).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_USER="$(id -un)"
[ "$RUN_USER" = "root" ] && RUN_USER="${SUDO_USER:-root}"   # `sudo bash setup.sh` still runs the service as you
ENV_FILE=/etc/starnet/starnet.env
# The env file wins over the unit's default (systemd reads it later), so health check + tunnel hint must use it too.
PORT="$(sudo sed -n 's/^STARNET_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -1 || true)"   # no env file yet is normal
PORT="${PORT:-${STARNET_PORT:-8787}}"
NODE_MAJOR=22   # matches CI (.github/workflows/fast-gate.yml)

[ "$RUN_USER" = "root" ] && { echo "Run as your normal VM user (ubuntu/opc), not root." >&2; exit 1; }
[ -f "$REPO_DIR/sidecar/index.js" ] || { echo "Not a StarNet checkout: $REPO_DIR" >&2; exit 1; }

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  if command -v apt-get >/dev/null; then
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v dnf >/dev/null; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
    sudo dnf install -y nodejs
  else
    echo "Unsupported distro: install Node ${NODE_MAJOR}+ yourself, then re-run." >&2; exit 1
  fi
fi

# node-pty has no ARM64 Linux prebuild, so it compiles; git is what agents use for project work.
if command -v apt-get >/dev/null; then
  sudo apt-get install -y build-essential python3 git
else
  sudo dnf install -y gcc-c++ make python3 git
fi

cd "$REPO_DIR"
# as the service user even under `sudo bash setup.sh`, so later non-root updates can replace node_modules
sudo -H -u "$RUN_USER" npm ci --omit=dev

sudo tee /etc/systemd/system/starnet.service >/dev/null <<EOF
[Unit]
Description=StarNet station (headless sidecar, loopback only)
After=network-online.target
Wants=network-online.target

[Service]
User=${RUN_USER}
WorkingDirectory=${REPO_DIR}
Environment=NODE_ENV=production
Environment=STARNET_PORT=${PORT}
# Optional overrides (STARNET_WORKSPACES=..., provider keys) — create the file to use it.
EnvironmentFile=-${ENV_FILE}
ExecStart=$(command -v node) sidecar/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable starnet
sudo systemctl restart starnet   # a re-run must pick up new code, unit and env, not keep the old process

for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "http://127.0.0.1:${PORT}/api/health"; then
    echo "StarNet is up on 127.0.0.1:${PORT}. From your PC:  ssh -N -L ${PORT}:127.0.0.1:${PORT} ${RUN_USER}@<vm-public-ip>"
    exit 0
  fi
  sleep 1
done
echo "StarNet did not answer /api/health within 30s — check: journalctl -u starnet -n 100" >&2
exit 1
