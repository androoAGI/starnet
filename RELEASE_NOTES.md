# StarNet v0.15.4

Full Power no longer asks. In 0.15.3 an agent on Full Access asked before every command once its chat had read a web page, an email or a connector result, and the update itself switched Full Access off for every agent. This release takes both back. It also fixes a context meter that could lock a model out of new chats.

## Before you update

- **Already on 0.15.3? Turn Full Access back on once.** 0.15.3 set every agent that had FULL ACCESS back to ask first and turned FULL BYPASS off. This update cannot bring that back for you. Give Full Access again in each agent's dossier, or turn FULL BYPASS on in SETTINGS › PERMISSIONS. StarNet asks you to confirm it once, and from then on it stays.
- **Coming from 0.15.0 or older? Your Full Access is kept.** The update keeps FULL BYPASS and each agent's FULL ACCESS exactly as you set them, along with each agent's reach, tools and connectors.
- **Coming from 0.14?** This update includes everything in 0.15.0 and 0.15.3, including the one-way move of the station file to format v7. Read the 0.15.0 and 0.15.3 notes before updating.

## Full Power

- **A Full Access agent no longer asks before commands.** In 0.15.3, once a chat had read outside content, every shell command raised an approval card, the card's Full access key did not stop the next one, and every later task in that chat asked again. A Full Access agent now runs its commands with no card, whatever the chat has read.
- **Unattended work on Full Access runs again.** In 0.15.3 a routine, the night shift or a loop on a Full Access agent was refused its commands and its file writes after it read outside content. They run as they did before 0.15.3.
- **No card for file writes either.** A Full Access agent that has read outside content writes files outside its workspace without asking, project instruction files and scripts included.
- **Editing a Full Access agent keeps Full Access.** Changing its model, provider, instructions, personality or skills no longer shows a "keep Full Access" confirmation and no longer sets the agent back to ask first. The same holds for the terminal's model and personality commands and for a config import.
- **`.env` and `.git` are writable again on THIS COMPUTER.** For a Full Access agent whose reach is THIS COMPUTER (MY WHOLE COMPUTER) or STATION GEAR (WHAT I PLACED), the file tools write a project's `.env` and `.git` files again.
- **What Full Access means.** The agent acts on what it reads without stopping to ask you. For an agent that reads pages or mail you do not trust, choose ask first, or the TRUSTED PROJECT reach, which keeps it inside the folders you approved.

## What still asks or is refused

- **Turning Full Access on** is confirmed once, in a StarNet dialog.
- **An agent that asks first** asks exactly as it did in 0.15.3, including after outside content.
- **TRUSTED PROJECT reach** still keeps a Full Access agent inside its workspace and the project folders you approved, and still refuses `.env` and `.git`.
- **Saved logins and keys.** No setting lets the file tools read SSH and signing keys, cloud and developer CLI logins, the operating system's credential store or browser profiles.
- **Work that outside content started.** A run started by an incoming webhook, a watched folder or a forwarded message keeps the outside-content lock even on a Full Access agent: its commands are refused when nobody is watching.
- **Permission files** are still sealed: a change made to them outside StarNet is not obeyed.

## Context meter

- **A wrong reading no longer locks a model out of new chats.** One oversized first reading for a model could make every new chat on that model show a full context bar and refuse to send, and starting a new session did not clear it. StarNet no longer learns or uses a reading that could not be real, and a new chat is never blocked by an estimate for the model alone. A full reading of the conversation you are in still stops the send, as before.

## Known issues

- The known issues in the 0.15.3 notes still apply, except "StarNet can ask once more whether to keep Full Access", which this release removes.
