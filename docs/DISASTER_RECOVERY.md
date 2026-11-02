# Complete station disaster recovery

A recovery bundle is one verified file holding the files under your station's `WORKSPACES` folder, apart from the exclusions below, plus this window's browser state. It is different from **EXPORT STATION**, which writes your configuration only, without conversations or files.

**A bundle is not encrypted.** Anyone who can read the file can read your station. Keep it as private as your computer, and do not send it to anyone.

## What it preserves, and what it does not

A bundle carries your agents, rooms and props, conversations, memories, routines, loops, tasks, projects, deliverables, permissions, connector references, and the empty folders a git repository needs.

StarNet removes the credentials it can recognize:

- **Credential stores:** provider credentials, OAuth grants, channel tokens, service keys, browser credentials, and browser cookies.
- **Connector records:** secret fields, credential-named headers and env values, values shaped like tokens, sign-ins and tokens in URLs, and the values of credential flags such as `--api-key`.
- **Hooks:** the same rules apply to `hooks.json`. Each hook's command stays, so read it before you approve it again.
- **Credential files, by name, anywhere in the station:** `.env` and `.env.*` (not `.env.example`, `.env.sample`, or `.env.template`), `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `id_rsa` and its relatives, and `*.pfx`, `*.p12`, `*.ppk`. A `*.pem` or `*.key` is left out only if its content is a private key, so a `cacert.pem` or a Keynote deck stays.
- **Git sign-ins:** a sign-in in a remote URL, and `extraheader` lines, in `.git/config` and in checkpoint repositories.

StarNet cannot recognize everything. These are in the bundle as readable text, including anything pasted into them or written by a tool:

- conversations and transcripts
- agents' files and checkpoint history
- plugin data and app data
- hook commands

A file left out by name cannot come back from the bundle. The report names each one and it clears `verbatim`, so keep your own copy of anything you need.

These never travel, because they were your decision on this machine:

- **FULL BYPASS** is off after a restore.
- **Routines** come back switched off. They are all still listed. Turn them on in **SCHEDULES** when you have read them.
- **Loops** come back paused, each one listed. Resume one in **GOAL LOOPS** when you have read it.
- **Line triggers** come back off, each one listed. Switching one on again only fires on what arrives after that.
- **Connectors and channel bots** come back off, each one listed, even when the credential is still on this machine. Turn connectors on in **ABILITIES** and bots on in **CHANNELS** when you want them.
- **A routine's unsent result** is not sent. Its routine comes back paused, and resuming it sends the result.
- **Overseer reports** do not run by themselves. A queued one is not run, and a worker that finished or was still running at backup time does not start one. Both are listed, and each worker's result stays readable in its conversation. A worker you resume reports as usual.
- **"Always allow" grants** are cleared, and StarNet asks again the next time an agent needs one.
- **How much agents may do on their own** is back at its default.
- **Approvals** for hooks, plugins, and skills are not restored. `hooks.json` and `plugins/` come back inert, and each one asks again.
- **Absolute-path authorization** is not restored. Project references stay, and a restored project shows as revoked until you authorize or relocate it.

A restore switches off what StarNet knows starts by itself. It does not stop everything. Once a provider is signed in, a run that was interrupted before the backup can continue when you open its conversation. A rating you gave in the last 72 hours can start a skill review, the daily quest refresh can make one model call, and a prop job already started can finish.

Every report lists what to redo under `reauthentication`. Pre-update snapshots follow the same rules, so restoring one also loses `.env` files and all of the above. A restore cannot tell a snapshot from an edited file, so it treats them alike.

## Create a recovery point in the app

This is the supported way for an installed app, including one with encrypted connector state.

1. Open **SETTINGS > APP & BACKUP > RECOVERY BUNDLE** and press **CREATE RECOVERY BUNDLE**. If an agent is working, it says so and writes nothing. It never stops an agent's work. Let the run finish or stop it, then press again.
2. StarNet saves your window, pauses changes, captures the station, writes the file, reads it back, and resumes. The file goes in your Downloads folder (your home folder if there is none) as `starnet-recovery-<date>-<time>.starnet-recovery.json`. An existing file is never overwritten.
3. Read the result. It gives two separate answers:
   - **Categories:** "All required categories are present", or which ones have nothing in the bundle. A category you never used has nothing in it, and that is normal.
   - **Files:** "Nothing was skipped, nothing was repaired from a .bak, no torn file was kept", or a list of everything that was.
4. Copy the file to private storage that is not on this computer's disk. Downloads is outside the app-data folder that **ERASE EVERYTHING** clears, but it is on the same disk as your station.

The panel also shows the exact commands for this install, in the shell it names, with its own Node, tool, station folder, and the bundle you just made filled in. **COPY CHECK COMMAND** copies only the rehearse command, so a paste can never start a restore. Copy the restore command by hand when you mean to run it. The rest of this page uses those commands.

If StarNet stops partway through writing, the unfinished file stays in Downloads until the desktop app's next start, which removes it. A source launch does not clean it up, so delete it by hand.

### What the answers mean

| Field | Question it answers | Notes |
| --- | --- | --- |
| `requirements` | Does each category have files in the bundle? | Counted from the files. `missing` is normal for a category you never used. `omitted` means its store could not be read. |
| `integrity.verbatim` | Is this an exact copy of what is on disk, apart from what is always excluded? | False if anything was unreadable, too large, a link, a credential file left out by name, replaced from a `.bak`, kept torn, omitted, or had a name that cannot be stored safely. Counts are in `integrity.counts`, and each row is in `skipped`. |
| `verdict.restoreNeeds` | Which flags does a restore need? | See [What a restore asks for](#what-a-restore-asks-for). |
| `complete` | Is every category present? | Information only. It no longer decides whether a bundle restores. |

`integrity.counts.excludedByDesign` counts credential stores, approvals, locks, runtime state, downloaded browsers, and older `.bak` generations of StarNet's own stores. These are left out of every bundle and are not gaps. A bundle made before these fields existed never reads as verbatim, because it did not record torn files.

Links inside the station, such as a pnpm or venv tree, are named but not followed, so run that project's install step again after a restore.

Checksums show that a file was not damaged after it was written. They do not prove the station was healthy when it was captured, so read the second answer too. They also do not prove who made the file: see [Only restore your own bundles](#only-restore-your-own-bundles).

A bundle is one JSON text, limited to about 448 MB of text. A larger station keeps its saves and stores first and lists the largest agent files it left out, as `too large for one recovery bundle`. A restore of that bundle needs `--allow-incomplete`.

### Pre-update snapshots

Each in-app update also writes a bundle to `update-snapshots`, beside your `WORKSPACES` folder, and StarNet keeps the newest three. These files work with `inspect`, `rehearse`, and `restore`. They are capped at 256 MB of file contents, list what they left out, and are removed by later updates or by **ERASE EVERYTHING**, so they do not replace a recovery bundle you keep.

## Create a recovery point when the app will not open

Quit StarNet first, including from the tray. The tool refuses a station that a running StarNet holds.

The desktop app has a fixed station folder: on Windows, `%APPDATA%\ai.skynet.harness\workspaces`. It installs Node and this tool in its install folder, by default `%LOCALAPPDATA%\StarNet`. Run this in PowerShell:

```powershell
& "$env:LOCALAPPDATA\StarNet\node.exe" "$env:LOCALAPPDATA\StarNet\bin\station-recovery.js" backup --workspace "$env:APPDATA\ai.skynet.harness\workspaces" --output "D:\Backups\starnet-$(Get-Date -Format yyyyMMdd-HHmmss).starnet-recovery.json"
```

The tool refuses to overwrite an existing file, and refuses an output path inside the station.

From a source checkout, the same tool runs as `npm run recovery:backup -- <arguments>`, and likewise `recovery:inspect` and `recovery:restore`. A source launch defaults to `%LOCALAPPDATA%\StarNet\workspaces` on Windows and `$XDG_DATA_HOME/StarNet/workspaces` (or `~/.local/share/StarNet/workspaces`) elsewhere.

The offline tool has no access to your OS credential store, so it cannot open an encrypted connector store. It does not fail. It writes the rest of the station and leaves that store out:

- The report's `omitted` list names `connectors/state.json`, the reason, and how to get it (`howToGet`): create the bundle from the running app, or add those connectors again after restoring.
- `connector_references` reads `omitted`, so restoring needs `--allow-incomplete`.
- Neither the credentials nor the encrypted bytes are in the file.

A category you never used does not stop a backup. If no agent save in the folder can be read, the tool writes nothing, exits with code 2, and says so, because that usually means the wrong folder. Run it again with `--allow-no-agents` to write the file anyway.

To include browser state in an offline bundle, add `--browser-state` with a file from **EXPORT AGENT** on the RESUME screen. Without it, the station is still captured from `WORKSPACES`.

## Check a bundle without touching a station

Replace the path with your own bundle:

```powershell
& "$env:LOCALAPPDATA\StarNet\node.exe" "$env:LOCALAPPDATA\StarNet\bin\station-recovery.js" inspect --bundle "D:\Backups\my-bundle.starnet-recovery.json"
& "$env:LOCALAPPDATA\StarNet\node.exe" "$env:LOCALAPPDATA\StarNet\bin\station-recovery.js" rehearse --bundle "D:\Backups\my-bundle.starnet-recovery.json"
```

`inspect` validates every checksum and prints the answers, counted from the bundle's files and rows. `rehearse` restores the bundle into a temporary folder, captures it again, compares the content with what a restore should land, and removes the folder. It is safe while StarNet is running. It proves the bundle restores to what it holds. It does not prove that an app opens it.

### Test in a clean profile

To see a restored station open in the app without affecting your own, use a separate Windows account. StarNet's station folder, browser state, and credential store are all per account:

1. Sign in to the other account, install StarNet, launch it once, and quit it, including from the tray.
2. Follow the restore steps below in that account.

## Only restore your own bundles

A bundle is not signed. Its checksums catch damage, but anyone who edits the file can recompute them and can rewrite its report. StarNet cannot tell whether a file is the one you made, and what `inspect` says about a bundle is only as trustworthy as the file.

To limit what a bundle from someone else can do, a restore refuses a bundle with paths that escape the station or with lock, owner, or browser-profile paths. It does not write device names, NTFS streams, or names this disk cannot store. It names them in `droppedOnRestore`, and the rest of the bundle restores. It also applies the capture rules again to every file, so an old or edited bundle cannot restore FULL BYPASS, an approval, armed routines, an "always allow" grant, or a raw credential store. It still restores agents, files, routines, and hook commands that you did not write, and those can run once you turn them on and a provider is signed in, so restore only a bundle you made yourself.

## Restore

StarNet has no setting to open a different station folder, and the desktop app sets its folder itself on each launch. So a restore puts the bundle in the folder the app already reads, and keeps what was there.

1. If StarNet is not installed, install the same or a newer build, launch it once, and quit it completely, including from the tray. The launch creates the station folder, and **SETTINGS > APP & BACKUP > RECOVERY BUNDLE** shows the exact command for this install.
2. Restore. The target now exists, so `--replace-existing` is needed. The folder it replaces, including an empty new station, is kept beside it as `workspaces.rollback-<id>`:

   ```powershell
   & "$env:LOCALAPPDATA\StarNet\node.exe" "$env:LOCALAPPDATA\StarNet\bin\station-recovery.js" restore --bundle "D:\Backups\my-bundle.starnet-recovery.json" --target "$env:APPDATA\ai.skynet.harness\workspaces" --replace-existing
   ```

   A target that does not exist does not need `--replace-existing`, and an existing one is refused without it. The tool prints what the bundle holds before it moves anything.

3. Launch StarNet. The station file is authoritative, so a window with no unsaved changes opens the restored station. A window that held unsaved changes when it closed has them merged in, and the save notice says so.
4. Optional: the restore also writes `starnet-browser-restore.json` beside the station folder (or at `--browser-output`), holding window settings such as the camera and layout. If StarNet opens on its RESUME screen, for example because no provider is signed in yet, **RESTORE BACKUP** imports it. If StarNet goes straight into the station, that button is not shown and the station is already restored. The report says when the bundle holds no browser copy and this file cannot be imported.
5. Work through every row in `receipt.reauthentication`: sign back in to providers, connectors, and channels, re-enter service keys, turn routines, loops, line triggers, connectors, channel bots, and FULL BYPASS back on if you want them, set how much agents may do on their own, approve hooks and plugins again, and reauthorize or relocate project folders. `receipt.droppedOnRestore` lists anything in the bundle that the restore did not write.

### What a restore asks for

A category you never used does not stop a restore. Two things do, and each has its own flag:

| Flag | When it is needed |
| --- | --- |
| `--allow-incomplete` | Something was lost on the way in: a file unreadable, too large, a link with data outside the station, replaced from a `.bak`, kept torn, omitted, or with a name this disk cannot store, or an agent save that does not parse. |
| `--allow-no-agents` | The bundle holds no readable agent save, so it would replace your station with nothing. This usually means the wrong file. |

`verdict.restoreNeeds` in `inspect` names the flags a bundle needs. Use them only when the bundle is all you have.

### If a restore fails

Restore writes each file, flushes it to disk, and reads it back before it changes the target. It refuses while a running StarNet holds the station, and it waits out a scanner or sync tool that holds a folder for a few seconds. If the folder is still held, it stops and says so. Close the antivirus, backup, or sync tool, or wait a minute, and run it again.

If activation fails, the old folder moves back. If that move also fails, the error includes `stationDisplaced` and `recover`, which name where your station is:

1. **Do not open StarNet.** It would create a new, empty station in the normal place. Your own station stays in the `workspaces.rollback-<id>` folder either way, and nothing is lost.
2. Close whatever holds the folder.
3. If StarNet was opened anyway, quit it completely and move the new `workspaces` folder aside.
4. Rename `workspaces.rollback-<id>` back to `workspaces`.

A restore also removes stage files that an earlier stopped restore left behind.

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
