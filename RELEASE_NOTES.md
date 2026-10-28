# StarNet v0.14.1

The stability update. It fixes bugs you reported, starting with stations that stopped saving, and it makes windows open faster and StarNet easier to find your way around.

## Your station saves again

- **Stations stop disappearing.** If StarNet closed unexpectedly between two saves (a crash, a killed app, a computer restart), the reopened window could have every later save refused, so the station file stopped updating while the app kept working, and an old station could come back later. The station now records which window wrote each save, so that window's newer work is accepted when it comes back.
- **When StarNet reopens, a window's unsaved work is merged in, not refused,** even when it can't be proven newer (as long as no other StarNet window is open). Sessions from both sides are kept, the station file is backed up first, and anything that can't be merged is kept in a copy beside it.
- **Lost work can come back.** If 0.14.0 already set some of your work aside, StarNet offers to restore that window's sessions when it starts.

## Easier to find your way

- **CONNECT is one list you can read at a glance.** APPS, CONNECTED (with your API keys), SKILL MARKET, SKILLS, TOOLS and EXTENSIONS all show at once, like SETTINGS, instead of three switches that swapped the sections under them. Old links and saved places still open where they belong.
- **New names in CONNECT.** CATALOG is now APPS, your API keys are under CONNECTED › API KEYS, BUILT-IN ABILITIES is TOOLS (with COMPUTER CONTROL), SKILL LIBRARY is SKILLS (with LEARNED SKILLS), and SKILL EXCHANGE is ADD FROM A LINK in SKILL MARKET. Forms for adding a service or a key open with one click.
- **AI & MODELS is sorted by what you have.** Its AI services now sit under four headings: StarNet credits, a subscription you have, an API key, or your own models. TOOLS, API keys, computer control, SCHEDULES, LIVE DOCTOR, Runtime limits and the model settings now say what they do in plain words.
- **Long windows are easier to read.** CONNECT, SETTINGS and the dossier open taller, and the app catalog and skill market fold by category; search opens whatever it finds.
- **Agents point you to the right place.** When a key is missing, agents now send you to CONNECT › ABILITIES › CONNECTED › API KEYS, and a new routine points you to AUTOMATE › SCHEDULES, not screens that no longer exist.

## Faster windows

- **Windows open faster.** In our tests on a large station, the median wait from click to window fell about 40%, and opening ABILITIES no longer freezes the station for seconds.
- **The window comes first.** While a window opens, the station holds off its own drawing for up to a quarter of a second, so the window gets the first chance to appear.
- **SETTINGS no longer rebuilds itself** when a background check comes back unchanged.

## See your crew work

- **Working agents show what they're doing.** A small tag right above each working agent shows its name and its task, or the tool it's using when it has no task. The agent you're talking to, or the one under your pointer, gets the full card: its task when it has one, the tool it's using right now, how long it has been running and, on a priced model, what it has cost. Tags take your theme's colour and zoom with the station.
- **Hand-offs are visible.** When an agent splits work across its crew, a line runs across the floor from the lead to each worker for as long as that worker runs, and the result rides back when it finishes.
- **Workers' steps reach the station.** When an agent you're working with in the app hands a job to its crew, each worker's current tool now shows on its CREW card and its card on the floor, not just WORKING. (Workers of a job started from a group chat, Telegram, a routine or the terminal don't show their steps yet.)

## Agents

- **Workers aren't cut off mid-job.** A worker whose brief named one website and asked it to check or review something was capped at 3 tools and 45 seconds, even when the brief also asked it to write, fix or build. Now a brief that also asks it to write, fix, test, run, save or build gets the normal budget.
- **Agents read your folders with the file tools.** When you name a project folder, agents now read, list and search it with the file tools instead of terminal commands. Choose Always on the folder's card and they can read it from then on without asking each time.
- **A key you paste into chat is saved to your API keys.** The agent stores it and refers to it by name, and COMMS shows a placeholder instead of the key. Only a key in the message you just sent is saved, so another agent in a group chat or an imported recipe can never add or change your keys.
- **Scheduled routines keep their notepad** in ASK mode. A routine could lose routine.notepad and still report success.

## Local models (Ollama)

- **Small models time out less on long tasks.** Once a big request raised the memory window, it never came back down, so on a smaller GPU the model spilled onto the CPU and a task could time out after 5 minutes. A task now steps the window back down to what its prompt needs when Ollama shows the model spilling onto the CPU. If your machine still needs longer, set `SKYNET_OLLAMA_CONNECT_TIMEOUT_MS` in milliseconds (600000 = 10 minutes) and restart StarNet.
- **Reasoning OFF really is off.** On Ollama, qwen3 and other models that can switch thinking off now stop thinking when reasoning is OFF, on chat turns and tasks alike.

## Look

- **The dashboard matches its windows.** Keys, session rows, NEEDS YOU, COMMS cards, menus and toasts now have rounded corners like the windows (crew cards keep their square shape), and highlighted rows and tabs use the windows' glass. The old mesh pattern behind the crew rail, sessions and dock is gone, so they no longer shimmer when you zoom out.
- **The crew rail and COMMS are easier to read.** Names stand out, status lines are quieter, a waiting session isn't announced twice, and "awaiting your answer" sits as a single line under the question.
- **A reply stands apart from its run again.** The RUN COMPLETE footer, the step rows and the run record go back to 0.13.5's dim phosphor with lowercase tool names, so they no longer compete with the agent's answer.
- **The + key no longer sits on PROJECTS** in a narrow window. The CREW column there now keeps the same width at every TEXT SIZE instead of shrinking, and its sessions row is tall enough to reach your sessions again.
- **A round of small fixes from a pass over every window:** dossier tabs fit on one row, manual chapters line up, the dock hint steps back while a window is open, trophy cards have more room, an empty NOTIFICATIONS list shows a drawn bell, and doubled settings headings are gone.

## Startup and the CLI

- **"Could not start its local engine" now says why.** If the engine fails at startup, its last lines of output appear in the error window and in startup.log, with keys removed, so you (and we) can see what went wrong. The engine's output is also kept, keys removed, in a new sidecar.log next to startup.log.
- **`starnet` works with the app closed.** `starnet`, `starnet -p` and `starnet flow run` start StarNet in the background (no window) and connect to your station, instead of asking you to open the app first. Quick questions like `status`, `ls`, `approve` and `watch` don't start it; they tell you to run `starnet` first. When the last `starnet` session ends, StarNet closes again, the same as closing its window. It stays in the tray if something is set to run in the background (routines, a connected channel like Telegram) or CLOSE WINDOW TO TRAY is on, and if you opened its window in the meantime, it stays open. On macOS, open the window from the menu-bar icon (clicking the Dock icon doesn't bring it back yet).
- **Steadier terminal sessions.** Opening StarNet no longer closes a `starnet` you already had running in a terminal, and in `starnet -p`, Ctrl-C and `--timeout` now stop the agent you started, even after it has handed work to its crew.
- **`/theme` in the terminal.** Pick the StarNet app's own colors (classic amber, Pip-Boy green, blue, purple, white) or keep the neon red. The whole dashboard recolors at once (logo, labels, camera feed), and your pick sticks for the next `starnet`. `STARNET_THEME=<name>` overrides it.
