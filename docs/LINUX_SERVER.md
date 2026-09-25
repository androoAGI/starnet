# Private Linux server

Run the browser server as a dedicated `starnet` system account on a trusted, single-owner
Linux host. This optional systemd setup uses the existing sidecar and browser UI. It is
independent of the desktop installer and does not add a public web login or multi-user hosting.

The service account has no interactive login, sudo, or Docker-group access. systemd hides
`/home`, `/root` and `/run/user`, makes the host filesystem read-only, and gives the service
private temporary storage. Station data is writable under `/var/lib/starnet`, with private
permissions. Network access remains available for model providers and Git. Direct GPU/device access is
disabled; use a separately managed inference endpoint for GPU models.

## Install

Prerequisites: systemd, Git, npm, and Node.js 22 or newer at `/usr/bin/node`. Install these through
your normal administrator-managed packages. If Node lives elsewhere, set an absolute, root-owned
`ExecStart` with `sudo systemctl edit starnet-server`; clear the original `ExecStart=` first.
Use that binary for the version check below, too.
A runtime under a personal home is hidden. Use a clean, reviewed, committed checkout; the
archive below includes tracked application files only, excluding local workspaces and credentials.
The minimal server supports chat, files and shell/Git work. Native voice, PTY, browser automation
and desktop integrations need their own dependencies; this setup does not install them.

From the checkout, run this block in Bash. It stops on errors and refuses an existing account
or installation. Do not reuse another installation's account or data; see Upgrades below.

```bash
(
set -euo pipefail
for target in /opt/starnet-server /var/lib/starnet /etc/starnet \
  /etc/sysusers.d/starnet.conf /etc/systemd/system/starnet-server.service \
  /etc/systemd/system/starnet-server.service.d /run/systemd/system/starnet-server.service.d; do
  if sudo test -e "$target" || sudo test -L "$target"; then
    echo "Already exists: $target; inspect it before installing"; exit 1
  fi
done
if getent passwd starnet >/dev/null || getent group starnet >/dev/null; then
  echo 'starnet account/group already exists; inspect it before installing'; exit 1
fi
/usr/bin/node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
# Run dependency installation as your normal user; lifecycle scripts are not needed for this profile.
npm ci --omit=dev --ignore-scripts
test ! -L node_modules || { echo 'Use a real dependency directory, not a symlink'; exit 1; }
sudo install -d -o root -g root -m 0755 /etc/sysusers.d
sudo install -m 0644 deploy/linux/starnet.conf /etc/sysusers.d/starnet.conf
sudo systemd-sysusers /etc/sysusers.d/starnet.conf
sudo install -d -o root -g root -m 0755 /opt/starnet-server
git archive HEAD sidecar shared frontend package.json package-lock.json LICENSE NOTICE.md |
  sudo tar --extract --no-same-owner --directory /opt/starnet-server
sudo cp -R node_modules /opt/starnet-server/
sudo chown -R root:root /opt/starnet-server
sudo chmod -R a+rX,go-w /opt/starnet-server
sudo install -d -o root -g root -m 0700 /etc/starnet
sudo install -m 0644 deploy/linux/starnet-server.service /etc/systemd/system/
sudo systemctl daemon-reload
)
```

Configure providers with `sudoedit /etc/starnet/server.env`, then `sudo chmod 0600 /etc/starnet/server.env`.
For an OpenAI-compatible gateway, for example:

```ini
CUSTOM_OPENAI_BASE_URL=https://your-gateway.example/v1
CUSTOM_OPENAI_KEY=your-application-key
```

systemd reads this root-owned file and passes the values to the service. Do not put keys in
Git, command arguments or a systemd unit. Use a restricted application key rather than a
provider administrator key. The browser's Custom provider still needs the endpoint and model
selection; leave its key field empty when the server holds the key.

```bash
sudo systemctl enable --now starnet-server
curl --fail http://127.0.0.1:8787/api/health
sudo journalctl -u starnet-server -n 30 --no-pager
```

Use an unused `STARNET_PORT` in `server.env` if a desktop or another station already owns 8787.
The service preserves its data on stop/restart. It starts a separate station and does not import
your personal desktop data or keys.

## Connect from another computer

Use your normal administrator SSH account, not the `starnet` service account:

```bash
ssh -NT -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:8787:127.0.0.1:8787 admin@your-server
```

Open `http://localhost:8787` on that computer. SSH must permit that forward. Keep the listener
on loopback; do not publish it through a reverse proxy, bind it to the LAN, or treat the
per-launch browser token as a multi-user login. Both the server and tunnel client must be
trusted single-owner machines. Refresh open tabs after restarting the server.
Closing the browser is not a durable remote-job contract; this setup preserves the current
sidecar behavior. [PR #21](https://github.com/androoAGI/starnet/pull/21) separately proposes
owner login, a desktop remote connection, and server-owned run/session lifecycle. Its design
has not been adopted by this guide.

## Agent folders, Git and stronger isolation

The existing execution router gives each agent `/var/lib/starnet/workspaces/<agentId>/`.
Clone repositories there; normal Git operations, build commands and provider requests work
without giving the service access to your personal home. Configure a bot commit identity and,
when needed, a repository-scoped deploy credential. Never copy your personal SSH directory,
forward your personal SSH agent, or grant passwordless sudo to the service account. Verify
SSH host keys through a trusted channel; do not disable host-key checking.

These folders organize work, but local processes share the **same OS account**. Agents are
not isolated from one another or from the station's data merely because their working
directories differ. Application permissions and approval prompts still apply. An approved
local program can access data available to the service account and use its network access.

StarNet already has a per-agent `SAFE CELL` Docker profile for separate execution environments;
see [Execution Backends](EXECUTION_BACKENDS.md). It supplies a persistent container
with only that agent's workspace mounted, and refuses execution when its backend is unavailable.
This service profile does not provision a container daemon. Do not add `starnet` to the
rootful Docker group or expose a rootful Docker socket: that grants host-root authority.
A rootless daemon on a dedicated executor, using the existing `REMOTE SSH` profile where
appropriate, needs a separate deployment review. Container and remote backends have not been
validated with this service profile. Keep local work within the dedicated account's trust boundary.

## Upgrades and removal

Stop the service and back up `/var/lib/starnet` and `/etc/starnet` privately before upgrading.
Install dependencies from the new lockfile as your normal user. Prepare a new root-owned
application directory using the same archive and dependency-copy commands, then replace `/opt/starnet-server` while the service is stopped. Keep the prior code
for rollback, but do not assume older code can read newer station data. Never overwrite or
remove station data as part of installing code. Copy an updated unit, run `daemon-reload`,
and restart; verify health and data persistence before deleting the prior application copy.

To retire the service, `sudo systemctl disable --now starnet-server`. This leaves data intact.
Remove the unit, sysusers configuration and application directory only after checking paths;
remove the service account and private data separately when you intend to discard the station.

## Verify the service boundary

An opt-in integration check exercises actual restrictions and a local Git clone/commit/push
without using credentials or contacting a Git host. From the reviewed checkout, install the
check and add a temporary service pre-start command:

```bash
sudo install -m 0644 test/linux-server.integration.mjs /opt/starnet-server/deployment-test.mjs
sudo install -d -m 0755 /run/systemd/system/starnet-server.service.d
printf '[Service]\nExecStartPre=/usr/bin/node /opt/starnet-server/deployment-test.mjs\n' |
  sudo tee /run/systemd/system/starnet-server.service.d/verify.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart starnet-server
sudo journalctl -u starnet-server -n 30 --no-pager
```

The check must report `Linux server isolation and Git integration: PASS`; a failed check
prevents startup. Also verify `/api/health`, load the browser UI, and confirm a station workspace
file survives a service restart. Schedule this check while no work is running. Afterwards remove
only `/run/systemd/system/starnet-server.service.d/verify.conf` and the installed
`deployment-test.mjs`, then run `sudo systemctl daemon-reload`. If you changed the Node path in the service, use that path in `ExecStartPre` too.
Keep the unit's restrictions in place.
