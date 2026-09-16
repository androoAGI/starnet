# Final selected roster and workstation review

The user accepted Pikachu's exact v0.11.2 set and chose to keep the completed Station Minion instead of the unfinished duplicate Minion. The demo roster now contains 37 skins: 36 complete new-style sets and one accepted release set. Original Minion source assets remain archived and unchanged; the unfinished duplicate is excluded from this demo roster.

The completion audit passes with 37/37 selected sets and zero missing required frames. Pikachu is checked against its approved release contract, not misrepresented as a newly generated eight-direction set. Catalog, input consistency, contact, movement and pace checks pass. The movement regression covers 555 cases; source and website copies match.

The localhost demo adds Preview at workstation / Return to live movement. This explicitly labelled art pose uses the real workstation anchor, seated renderer, typing track, lighting and depth ordering; it creates no harness work event or task. Switching skins/follow targets/groups exits the preview. The selected live body's drawing is replaced temporarily; its actual activity is unchanged.

Live inspection exposed compact seated bodies being hidden too far behind the tall industrial chair. The demo sprite renderer now supplies a seven-world-pixel cushion lift for new-style workstation sit/type poses when no furniture-specific lift exists. This leaves standing height, walking and retained Pikachu untouched. The Silver Cadet was inspected at 19 px in the live station with its head/shoulders above the chair and animated north-facing typing frames. The preview remains open for visual review. These changes are saved in the isolated skin worktree; they are not a production merge.
