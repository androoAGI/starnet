#!/bin/bash
set -euo pipefail
# Run from a reviewed checkout/archive. Installs only the small pure-JS validator.
[[ $(id -u) == 0 ]] || { echo 'Run with sudo' >&2; exit 1; }
[[ ${1:-} =~ ^[1-9][0-9]+$ ]] || { echo 'Usage: sudo remote/install-linux.sh GITHUB_OWNER_ID' >&2; exit 1; }
source_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
case $(uname -m) in
  x86_64) runtime_name=node-linux-x64 ;;
  aarch64|arm64) runtime_name=node-linux-arm64 ;;
  *) echo 'Supported server architectures: x86_64 and arm64' >&2; exit 1 ;;
esac
packaged_node="$source_root/remote/runtimes/$runtime_name"
if [[ -f "$source_root/PACKAGE-SHA256.json" && -x "$packaged_node" ]]; then
  node_path="$packaged_node"
  "$node_path" "$source_root/remote/verify-package.js" "$source_root"
else
  node_path=$(command -v node)
fi
"$node_path" -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
release_id=$(git -C "$source_root" rev-parse --short=12 HEAD 2>/dev/null || cat "$source_root/RELEASE" 2>/dev/null || date -u +%Y%m%dT%H%M%SZ)
[[ "$release_id" =~ ^[A-Za-z0-9]+$ ]] || { echo 'Invalid release identifier' >&2; exit 1; }
release=/opt/starnet/releases/$release_id
data_root=${2:-/var/lib/starnet}
[[ "$data_root" =~ ^/[A-Za-z0-9_./-]+/starnet$ ]] || { echo 'Data directory must be an absolute path ending in /starnet' >&2; exit 1; }
vault_condition=
if [[ "$data_root" == /srv/private/* ]]; then vault_condition="ConditionPathIsMountPoint=/srv/private"; mountpoint -q /srv/private || { echo 'Unlock the private vault first' >&2; exit 1; }; fi
if systemctl is-active --quiet starnet-remote; then
  echo 'A station is already running. Stop it explicitly after checking active runs before upgrading.' >&2; exit 1
fi
id starnet >/dev/null 2>&1 || useradd --system --home-dir "$data_root" --shell /usr/sbin/nologin starnet
install -d -m 0700 -o starnet -g starnet "$data_root"
[[ ! -e "$release" ]] || { echo 'Release already exists; refusing overwrite' >&2; exit 1; }
install -d -m 0755 "$release"
cp -R "$source_root/sidecar" "$source_root/shared" "$source_root/frontend" "$source_root/remote" "$release/"
printf '%s\n' "$release_id" > "$release/RELEASE"
cp "$source_root/package.json" "$source_root/LICENSE" "$source_root/NOTICE.md" "$release/"
if [[ -f "$source_root/PACKAGE-SHA256.json" && -x "$packaged_node" ]]; then
  node_path="$release/remote/runtimes/$runtime_name"
else
  npm ci --prefix "$release/remote" --omit=dev --ignore-scripts --no-fund
fi
chown -R root:root "$release"
# Archives may be built under a private umask. The service account must be
# able to traverse/read this immutable code and execute its bundled runtime.
# Private station data is outside the release and keeps its restrictive mode.
chmod -R a+rX,go-w "$release"
ln -s "$release" /opt/starnet/current.new
mv -Tf /opt/starnet/current.new /opt/starnet/current
install -d -m 0755 /etc/systemd/system /usr/local/bin
cat > /etc/systemd/system/starnet-remote.service <<EOF
[Unit]
Description=StarNet headless agent station and private gateway
After=network-online.target
Wants=network-online.target
RequiresMountsFor=$data_root
ConditionPathIsDirectory=$data_root
$vault_condition
StartLimitIntervalSec=120
StartLimitBurst=5

[Service]
Type=simple
User=starnet
Group=starnet
WorkingDirectory=$data_root
ExecStart=$node_path /opt/starnet/current/remote/cli.js serve --owner $1 --data $data_root --port 18791 --runtime-port 18792
EnvironmentFile=-$data_root/provider.env
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$data_root
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
MemoryHigh=768M
MemoryMax=1G
MemorySwapMax=0
TasksMax=256
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF
cat > /usr/local/bin/starnet <<EOF
#!/bin/sh
exec $node_path /opt/starnet/current/remote/cli.js "\$@"
EOF
chmod 0755 /usr/local/bin/starnet
systemctl daemon-reload
systemctl enable --now starnet-remote.service
for attempt in {1..40}; do
  if curl --silent --fail --max-time 2 http://127.0.0.1:18792/api/health >/dev/null; then
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 http://127.0.0.1:18791/)
    if [[ "$status" == 401 ]]; then echo "Installed $release_id: runtime healthy; gateway refuses unauthenticated access"; exit 0; fi
  fi
  sleep 1
done
systemctl stop starnet-remote.service
echo 'Readiness failed; station stopped. Inspect journalctl -u starnet-remote.' >&2
exit 1
