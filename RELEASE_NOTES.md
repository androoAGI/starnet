# StarNet v0.15.1

This update fixes chat history that would not load after updating to 0.15.0, and routines that would not run on stations set up from the terminal. It also lets you sign a station out of its StarNet account when the account can't be read, and when your StarNet credits run out the message now says to top up instead of blaming your provider. If you set your station up from the terminal on 0.15.0, open StarNet once after updating.

## Chat history

- **Chat history from before 0.15.0 loads again** (GitHub #178). On a station with a long history from 0.14 or earlier, 0.15.0 showed "Conversation history could not be restored" and held every message you sent. 0.15.1 reads the old history through once, the first time it loads, and keeps what it learned, so later loads and restarts are quick. On a very large history that first load can take a few seconds, and the station waits for it (about 3 seconds for 400 MB of history in our test). A history with damage in it is still never shown as if it were whole.
- **A message cut off by a crash no longer locks the history** (GitHub #178). If StarNet stopped in the middle of saving a message (a crash, a force quit or a power cut), 0.15.0 refused the history from then on. Now the cut-off part is set aside in a file beside the transcript (its name contains `.torn-`) and the chat loads without that one message, which was never reported saved. The chat says so once: "The last unfinished message was set aside: StarNet stopped before it finished saving it."
- **A history the station can't read no longer tells you to try again.** When the station answers but can't read a chat's history, the message now says "Conversation history could not be restored: the station answered but could not read it. Your message is kept." Before, it said to try again when the connection returned, which would not help.

## Stations set up from the terminal

- **Routines run on a station set up from the terminal.** A station set up with `starnet` in a terminal on 0.15.0, and never opened in the app, saved its floor without naming what wrote it, so the station could not vouch for the floor. Every routine, Run Now and the rest of what runs with the app closed was refused with "the saved floor is invalid; routing is held until it is readable". A station set up from the terminal now names its writer, and its routines run without opening the app.
- **A station already set up this way says what to do.** Its refusal now reads "the saved floor is not yet saved by StarNet (open StarNet once to finish setting it up); routing is held until it is readable". The refusal costs nothing. Open StarNet once and let it save, and the routines run again, a routine refused earlier included, at its next try. See Known issues.

## StarNet credits

- **You can sign a station out of its StarNet account when the account can't be read** (GitHub #182). When SETTINGS › AI & MODELS › STORE says "Could not check your account connection" and the station may still be linked, it now offers UNLINK beside RETRY. UNLINK forgets the link on this computer only. Your credits stay on your account, and you link the station again with LINK STATION.
- **A StarNet credits refusal is no longer called your provider's billing** (GitHub #182). When StarNet refused a call for lack of credits, the message said your provider account was out of credit and sent you to the provider. Now it names your StarNet credits and says nothing was charged. When your credits can't cover the call, the first advice is to top up under SETTINGS › AI & MODELS, or connect your own provider key. When part of your balance is held by calls that haven't finished on your account, it says to try again in a few minutes, and to top up if your balance is low.

## Updating, and going back

- **Coming from 0.14?** Everything in 0.15.0 comes with this update, including its one-way step: the first save moves your station file to format v7 and keeps the old file for 30 days, beside it in the station folder, as `agent.save.pre-history-ref.json`. Open StarNet once after updating. Going back to 0.14.2 takes manual steps, listed in the 0.15.0 notes (https://github.com/androoAGI/starnet-releases/releases/tag/v0.15.0).
- **Going back to 0.15.0.** 0.15.1 keeps format v7. Installing 0.15.0 again reads the history 0.15.1 kept, but brings back the problems this update fixes.

## Known issues

- **StarNet's new "busy" reply reads as a provider overload.** When StarNet's cloud can't take a call right now, it answers with a new busy reply that 0.15.1 does not know yet. 0.15.1 treats it as an overloaded AI provider: the message can say the AI provider's servers are having trouble, StarNet tries the call again for a while, and if you set up a fallback provider the call may move to it. Nothing is charged for a refused call.
- **Other damage in a chat's history is still refused.** This update sets aside only a cut-off last message. If another message was saved after the cut-off one before you updated, or the damage is in an older transcript file (a crash on 0.14 can leave this), the history still does not load, with "Conversation history could not be restored: the station answered but could not read it. Your message is kept." The first kind can hold other chats' history too.
- **On a Mac, the in-app update can stop with a "cross-device link" error.** It happens when StarNet runs from a different disk than the Mac's temporary folder: an external drive, a disk image, or an app opened straight from Downloads. This update does not fix it, and the in-app update can't get past it. Download StarNet 0.15.1 from starnetos.com and install it over the app. Your station folder is kept.
- **A station set up from the terminal on 0.15.0 needs StarNet opened once.** Running `starnet` again does not redo its setup, so its routines stay held until StarNet saves the floor itself. Open the StarNet app (or the station's page in a browser) once and let it save. Stations set up from the terminal on 0.15.1 don't need this.
