# StarNet v0.11.1

This update improves linked-account reliability, voice playback, and everyday station controls.

- Fixed managed chat using stale per-request server settings or credentials instead of the linked StarNet account. Custom providers keep their own connection settings.
- Fixed image generation rejecting a linked StarNet credits account. Ordinary wording is less likely to trigger an unnecessary image-generation requirement.
- Saved room equipment now remains available when a chat request omits placement data, and tool availability descriptions better match the actual grants.
- Spoken replies buffer complete sentences and recover audio in order, with clearer interruption diagnostics.
- Background replies preserve the conversation you are currently viewing. Inbox rows have more readable message previews.
- Fixed work ratings on resumed legacy stations, retaining the station identity through restart.
- The glass interface is now standard across COMMS, model selection and station windows. Window interactions, text readability and Appearance previews have been improved.
- Station lighting, wall finishes and floor materials have been refreshed. New starter stations use a white shell, and prop details leave more room for browsing the build catalog.
- Global stop controls have been removed, with recovery for their legacy pause state. Individual work controls remain available.

Update through Settings > Updates > Update Center. After restarting, confirm that the installed version is 0.11.1.

Google Workspace connections remain deferred while Google verification is completed. Saved connections are retained. Google login for StarNet billing is separate.
