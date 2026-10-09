# StarNet v0.13.2

**Before you update:** if the in-app update from 0.13.1 stops with "Update paused - no verified recovery point was created", download the full installer from the releases page and run it over the top (your station is kept). If agents are working, choose WAIT FOR AGENTS, not INSTALL ANYWAY. macOS 10.15 Catalina is no longer supported: StarNet needs macOS 11+ with Safari 16.4+.

A large repair update: credits and spending tell the truth, in-app updates are safer, routines get their keys and tools back, the station runs lighter, and your agents can now drive StarNet for you.

## Behavior changes

- **Autonomy runs on your local day,** not UTC, and a focus you declare for it is enforced: off-focus ideas are dropped.
- **One "While you were away" session.** Routines, away builds, loops, autonomy drafts and failures fold into one pinned report instead of a session each.
- **Autopilot cabinet writes now really run** when a cabinet is placed and file writing is granted, with consent, a checkpoint and UNDO. Before, they always fell back to a desk draft.
- **A resumed run whose earlier history can't be verified starts locked** and says why.
- **From 0.13.2 on, in-app installs see all running work** (routines, workflows, channels, /v1 calls, background workers): WAIT FOR AGENTS holds the install, and INSTALL ANYWAY stops that work and lets it book its spend before writes freeze.
- **A greeting that names an agent** ("hey nova", "thanks claude") may start a task run with tools, and a retry or redirect like "ok, try it now" is now treated as a task.

**Before you downgrade:** settle any interrupted run in SETTINGS › SPENDING LIMITS first, or 0.13.1 refuses every run that has a spending limit set.

## Fixed

### Updates & recovery

- **From 0.13.2 on, in-app updates no longer stop on one unreadable file.** The recovery point skips locked or unreadable entries and lists them, and captures a WORKSPACES folder that is a link (#91).
- **No stranded spend across an update.** From 0.13.2 on, INSTALL ANYWAY lets stopped runs book their spend first, and the "saved by a newer StarNet" screen offers DOWNLOAD LATEST when the in-app update can't finish (#91).
- **SAVE-NET recovery details** check whether the local engine actually answers instead of always saying REACHABLE.
- **macOS:** an outdated web engine is named as such, never "a broken file".

### Credits, StarNet link & spending

- **A funded account is never told it is out of credits.** A failed balance check says so, a refused link says relink, a balance held by your own running runs is called held, and a PER RUN cap above your balance is clamped to it.
- **Slow link checks no longer hide your account.** WAKE, the STORE, the connect screen and SETTINGS wait out a slow link repair, and a link that met a down account service repairs itself; RETRY AUTO-RESUME re-reads it (#76).
- **The desktop app keeps its StarNet link across restarts** (#93).
- **StarNet Managed models:** a saved model like gpt-5.5 is matched to the managed catalog instead of being wiped to "not available", and CHOOSE MODEL no longer opens and instantly closes.
- **Interrupted runs can be settled.** SPENDING LIMITS lists each one: enter its charge and SETTLE, or COUNT AS its per-run limit. It no longer refuses runs that have a limit set with "Spend history is unavailable"; a graceful Quit books stopped runs' spend.
- **Spend stops point at SETTINGS › SPENDING LIMITS,** and SAVE LIMITS saves only the limits you changed.
- **LINK DOWN says why** the station service is gone and, on desktop, offers a restart. Pairing failures name which side failed.

### Providers & models

- **Claude Opus 5.5, Sonnet 5.5 and Fable 5.1 conversations no longer fail with "Invalid signature in thinking block"** on the Anthropic provider (#73, #94), and Sonnet 5.5 with thinking OFF works. Haiku 5.5 history edits and 5.5 price estimates are corrected.
- **Claude Code agents can see images,** and reuse their cached prompt across runs (#68).
- **Gemini** no longer refuses every request with a station-planning tool attached.
- **Mistral, OpenRouter and other OpenAI-compatible providers** no longer reject runs over extra message fields.
- **Groq** retries a badly formed tool call instead of ending the run.
- **ChatGPT:** an expired sign-in shows ⏼ RECONNECT on its card (#92).
- **Key checks tell the truth:** a refused Anthropic key says HTTP 401, a network failure names its cause (#90); OpenRouter keys verify through tunnels (#62); Kimi uses your account's region (#70).
- **Anthropic quick picks** offer current models (Opus 4.1 and Haiku 3.5 were retired).

### Routines & workflows

- **In browser mode, routines, Run Now and autonomy use the key you saved in the browser** (#89): StarNet keeps a copy in WORKSPACES/.secrets/provider-keys.json, and REMOVE deletes it. A line's schedule runs on its agent's provider.
- **Routines saved before 0.13.2 get their web tools back** (#58): their saved tool list is repaired and saved once on first start. Unknown toolset names are refused by name, and Run Now gets the same tools as the scheduled run.
- **Workflows with no WORKING FOLDER** tell the agent its files stay private and how to save into a trusted project (#60, #81).
- **Delegated images and voice files** land in the trusted project, so the lead and the next Conveyor stage can read them, and a worker in ASK mode is told why it has no shell (#77, #88).

### Station browser & web

- **The station browser heals itself.** An orphaned browser is cleaned up, a held profile falls back to a fresh temporary one, and RESET STATION BROWSER is named when needed (#61).
- **Clearer failures:** failed loads, tunnel refusals, TLS errors and unreachable search engines name the real cause and host.
- **Tabs behave:** new-tab links open in the same tab, a closed first tab no longer strands the browser, and clicks and typing never land on a different tab.
- **One-site requests keep the browser,** and a page quoting an error is no longer read as a dead host.

### Station & UI

- **Faster, lighter station.** The world draws at 30 fps focused and 5 fps in the background, and conveyors, lighting and the session rail cost far less (#69).
- **QUEST LOG no longer freezes the app.**
- **Window text is selectable,** and OPEN THE FULL CONVERSATION opens a workflow's session (#87).
- **Hover hints work on touchscreen laptops** driven by a mouse.
- **Copy diagnostics works on macOS.** NEEDS YOU counts match the rows shown.
- **Connectors:** editing keeps saved secrets, errors say why, OAuth sign-in survives a port change, and Intercom signs in with OAuth.
- **API keys** are used with Windows syntax in shell commands.
- **E-STOP** says when a run stopped itself and offers no TRY AGAIN.

## New

- **Your agents can drive StarNet.** Ask in plain words and the agent opens any window for you, changes settings, and handles E-STOP, the away queue, cleanup, groups and notifications. Agents now understand every part of StarNet, and a lead can read which sessions are busy (#55).
- **Ctrl+K (Cmd+K on Mac) FIND** searches every window, agent and conversation.
- **Approvals show the whole request.** A long command or path is no longer cut at 80 characters: the card shows one short line, and "Inspect complete request" holds every character (known secret patterns hidden), with COPY COMMAND for shell commands. Group chats carry it too; Telegram and Discord approvals show up to 3000 characters and say when they cut.
- **/v1 and ACP editor runs can now use the agent's tools** under your PERMISSIONS and approvals (#96); a model without tools still answers in text.
- **HINTS switch** in SETTINGS › LOOK & SOUND turns hover bubbles off, also from chat (#79).
- **ERASE EVERYTHING** in SETTINGS › APP & BACKUP (desktop app) deletes all StarNet data on this computer and restarts fresh (#65).
- **One-click desk assignment:** a desk's card shows WHO SITS HERE chips.

## Changed

- **Autonomy remembers what it already built,** focuses on work you repeat, and keeps one version of a build waiting.
- **Permissions ask one question,** with the same three answers in SETTINGS and each agent's Dossier; AUTONOMY leads with ON ITS OWN.
- **Custom classes are one page;** tools and skills are built in.
- **DELIVERABLES** uses the new glass look.
- **macOS 11 Big Sur** is now the minimum (with Safari 16.4+, which macOS 13.3+ has built in).

Thanks to @bonjurroughs for prompt caching and hover hint fixes, and to @xLagerFeuer for the station status idea.
