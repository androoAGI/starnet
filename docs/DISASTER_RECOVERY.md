# Complete station disaster recovery

A recovery bundle is one verified file holding every non-ephemeral file under your station's `WORKSPACES` folder, plus this window's browser state. It is different from **EXPORT STATION**, which writes your configuration only, without conversations or files.

## What it preserves, and what it does not

A bundle carries evidence for these categories: agents, rooms and props, conversations, memories, routines, loops, tasks, projects, deliverables, permissions, and connector references.

Credentials and machine authority are deliberately left out: provider credentials, OAuth grants, channel tokens, service keys, browser credentials, browser cookies, and absolute-path authorization. Connector and channel identities and project references stay, and every report lists what to reconnect under `reauthentication`.

## Create a recovery point in the app

This is the supported way for an installed app, including one with encrypted connector state.

1. Open **SETTINGS > APP & BACKUP > RECOVERY BUNDLE** and press **CREATE RECOVERY BUNDLE**. If an agent is working, it says so and writes nothing. It never stops an agent's work. Let the run finish or stop it, then press again.
2. StarNet saves your window, pauses changes, captures the station, writes the file, reads it back, and resumes. The file goes in your Downloads folder (your home folder if there is none) as `starnet-recovery-<date>-<time>.starnet-recovery.json`. An existing file is never overwritten.
3. Read the result. It gives two separate answers:
   - **Categories:** "All required categories are present", or which ones are not.
   - **Files:** "Nothing was skipped, nothing was repaired from a .bak, no torn file was kept", or a list of everything that was.
4. Copy the file to storage that is not on this computer's disk. Downloads is outside the app-data folder that **ERASE EVERYTHING** clears, but it is on the same disk as your station.

The panel also shows the exact commands for this install, with its own Node, tool, and station folder filled in. **COPY STEPS** copies them. The rest of this page uses those commands.

### What the two answers mean

| Field | Question it answers | Notes |
| --- | --- | --- |
| `complete` | Does each required category have evidence in the bundle? | A category you never used can read `missing`. `omitted` means its store could not be read. Either one makes `complete` false. |
| `integrity.verbatim` | Is this an exact copy of what is on disk, apart from what is always excluded? | False if anything was unreadable, too large, a symbolic link, replaced from a `.bak`, kept torn, or omitted. Counts are in `integrity.counts`, and each row is in `skipped`. |

`integrity.counts.excludedByDesign` counts credentials, locks, runtime state, and older `.bak` generations. These are left out of every bundle and are not gaps. A bundle made before these fields existed never reads as verbatim, because it did not record torn files.

Checksums prove that a bundle has not changed since it was written. They do not prove the station was healthy when it was captured, so read the second answer too.

A bundle is one JSON text, limited to about 448 MB of text. A larger station keeps its saves and stores first and lists the largest agent files it left out, as `too large for one recovery bundle`.

### Pre-update snapshots

Each in-app update also writes a bundle to `update-snapshots`, beside your `WORKSPACES` folder, and StarNet keeps the newest three. These files work with `inspect`, `rehearse`, and `restore`. They are capped at 256 MB of file contents, list what they left out, and are removed by later updates or by **ERASE EVERYTHING**, so they do not replace a recovery bundle you keep.

## Create a recovery point when the app will not open

Quit StarNet first, including from the tray. The tool refuses a station that a running StarNet holds.

The desktop app has a fixed station folder: on Windows, `%APPDATA%\ai.skynet.harness\workspaces`. It installs Node and this tool in its install folder, by default `%LOCALAPPDATA%\StarNet`:

```powershell
& "$env:LOCALAPPDATA\StarNet\node.exe" "$env:LOCALAPPDATA\StarNet\bin\station-recovery.js" backup --workspace "$env:APPDATA\ai.skynet.harness\workspaces" --output "D:\Backups\station.starnet-recovery.json"
```

From a source checkout, the same tool runs as `npm run recovery:backup -- <arguments>`, and likewise `recovery:inspect` and `recovery:restore`. A source launch defaults to `%LOCALAPPDATA%\StarNet\workspaces` on Windows and `$XDG_DATA_HOME/StarNet/workspaces` (or `~/.local/share/StarNet/workspaces`) elsewhere.

The offline tool has no access to your OS credential store, so it cannot open an encrypted connector store. It does not fail. It writes the rest of the station and leaves that store out:

- The report's `omitted` list names `connectors/state.json`, the reason, and how to get it (`howToGet`): create the bundle from the running app, or add those connectors again after restoring.
- `connector_references` reads `omitted` and `complete` is false, so restoring needs `--allow-incomplete`.
- Neither the credentials nor the encrypted bytes are in the file.

If a category other than an omitted store is missing, the tool writes nothing, exits with code 2, and says so. Run it again with `--allow-incomplete` if you never used that category.

To include browser state in an offline bundle, add `--browser-state` with a file from **EXPORT AGENT** on the RESUME screen. Without it, the station is still captured from `WORKSPACES`.

## Check a bundle without touching a station

```powershell
& "$env:LOCALAPPDATA\StarNet\node.exe" "$env:LOCALAPPDATA\StarNet\bin\station-recovery.js" inspect --bundle "D:\Backups\station.starnet-recovery.json"
& "$env:LOCALAPPDATA\StarNet\node.exe" "$env:LOCALAPPDATA\StarNet\bin\station-recovery.js" rehearse --bundle "D:\Backups\station.starnet-recovery.json"
```

`inspect` validates every checksum and prints both answers. `rehearse` restores the bundle into a temporary folder, captures it again, compares the content, and removes the folder. It is safe while StarNet is running. It proves the bundle restores to what was captured. It does not prove that an app opens it.

### Test in a clean profile

To see a restored station open in the app without affecting your own, use a separate Windows account. StarNet's station folder, browser state, and credential store are all per account:

1. Sign in to the other account, install StarNet, launch it once, and quit it, including from the tray.
2. Follow the restore steps below in that account.

## Restore

StarNet has no setting to open a different station folder, and the desktop app sets its folder itself on each launch. So a restore puts the bundle in the folder the app already reads, and keeps what was there.

1. If StarNet is not installed, install the same or a newer build, launch it once, and quit it completely, including from the tray. The launch creates the station folder, and **SETTINGS > APP & BACKUP > RECOVERY BUNDLE** shows the exact command for this install.
2. Restore. The target now exists, so `--replace-existing` is needed. The folder it replaces, including an empty new station, is kept beside it as `workspaces.rollback-<id>`:

   ```powershell
   & "$env:LOCALAPPDATA\StarNet\node.exe" "$env:LOCALAPPDATA\StarNet\bin\station-recovery.js" restore --bundle "D:\Backups\station.starnet-recovery.json" --target "$env:APPDATA\ai.skynet.harness\workspaces" --replace-existing
   ```

   Add `--allow-incomplete` if the bundle's `complete` is false. Restore refuses an incomplete bundle otherwise. A target that does not exist does not need `--replace-existing`, and an existing one is refused without it.

3. Launch StarNet. The station file is authoritative, so a window with no unsaved changes opens the restored station. A window that held unsaved changes when it closed has them merged in, and the save notice says so.
4. Optional: the restore also writes `starnet-browser-restore.json` beside the station folder (or at `--browser-output`), holding window settings such as the camera and layout. If StarNet opens on its RESUME screen, for example because no provider is signed in yet, **RESTORE BACKUP** imports it. If StarNet goes straight into the station, that button is not shown and the station is already restored. The report says when the bundle holds no browser copy and this file cannot be imported.
5. Work through every row in `receipt.reauthentication`: sign back in to providers, connectors, and channels, re-enter service keys, and reauthorize or relocate project folders. A restored project shows as revoked until you do.

Restore stages and verifies everything before it changes the target. If activation fails, the old folder moves back. It refuses while a running StarNet holds the station.

## Roll back to a previous version of your station

Quit StarNet, then run step 2 above with the older bundle or a pre-update snapshot. To undo a restore, quit StarNet and restore a newer bundle, or move `workspaces.rollback-<id>` back into place by hand.

## Recovery-point objective

A bundle guarantees that no completed mutation is lost up to its barrier: the in-app path pauses changes for it, and the offline path needs StarNet stopped. The rehearsal below applies exactly one completed mutation after that barrier, damages the station, and measures exactly one lost mutation after restore.

StarNet does not claim an automatic continuous-backup RPO. Anything completed after your latest bundle is at risk until you create another.

## Run the destructive rehearsal

From a source checkout:

```powershell
npm run recovery:rehearsal
```

It uses disposable profiles and covers a clean-profile restore, a corrupt bundle, an interrupted backup, a missing required store, a full disk, a previous-version rollback, the measured recovery point, and an encrypted connector-vault fixture through both the running-app and offline captures. It writes a machine-readable inventory and a summary under `.dogfood/disaster-recovery-latest/`. It uses a synthetic key, so the real OS credential store and the installed app's UI stay separate attended proofs.
