# StarNet on an Oracle Cloud VM

Runs the StarNet station headless (the `npm start` sidecar) as a systemd service. The station stays bound to
`127.0.0.1` — its API guard (`sidecar/apiauth.js`) only admits loopback Hosts — so you open it through an SSH
tunnel. No ingress rule, firewall change, or TLS certificate is needed, and nothing is exposed to the internet.

## 1. Create the VM

- Image: Canonical Ubuntu 24.04 (or Oracle Linux 9). Shape: `VM.Standard.A1.Flex` (Always Free ARM) with
  2+ OCPU / 12+ GB RAM is comfortable; x86 shapes work too.
- Add your SSH public key. Leave the default security list (port 22 only).

## 2. Install

```bash
ssh ubuntu@<vm-public-ip>
git clone https://github.com/Mcgyver-ai/starnet-workforge.git starnet   # private repo: use a deploy key or `gh auth login`
cd starnet
bash deploy/oracle-vm/setup.sh
```

The script installs Node 22 and build tools, runs `npm ci --omit=dev`, writes `/etc/systemd/system/starnet.service`,
starts it, and waits for `GET /api/health`. Re-run it any time; it is idempotent.

## 3. Open it from your PC

```bash
ssh -N -L 8787:127.0.0.1:8787 ubuntu@<vm-public-ip>
```

Then browse to `http://127.0.0.1:8787` (use `127.0.0.1`, not `localhost`, which can resolve to `::1`).
Add provider keys in the app as usual; on a headless station they are stored in the station's `secrets.json`
(no OS keychain on a server), under `~/.local/share/StarNet/workspaces` on the VM.

For phone access without a tunnel, pair StarNet Remote from the app: the station dials out to the default relay
(`remote.starnetos.com`), which only forwards end-to-end sealed frames. `STARNET_REMOTE_RELAY=off` in
`/etc/starnet/starnet.env` turns it off.

## Operate

| Task | Command |
| --- | --- |
| Logs | `journalctl -u starnet -f` |
| Restart | `sudo systemctl restart starnet` |
| Update | `git pull && npm ci --omit=dev && sudo systemctl restart starnet` |
| Env overrides | `/etc/starnet/starnet.env` (`STARNET_PORT`, `STARNET_WORKSPACES`, …), then restart |
| Back up data | copy `~/.local/share/StarNet/workspaces` |

Agents run tools as the service user with that user's file access, so give the VM its own user and keys —
don't reuse credentials you would not hand to the agents.
