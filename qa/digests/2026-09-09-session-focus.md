# Session focus repair — 2026-09-09

agent/session-switch-investigation-0909 -> trunk 60e2042a37498e020f7742e87234063415889b31. Integration tree matches reviewed branch 92bb8c90d exactly. Snapshot before merge: 407b82b4dc9beffe7d2c007088bf66ba04856ce9. Existing qa/STATUS.md and Rooms handoff edits were hash-checked unchanged; this separate digest preserves their owner's work.

Reproduced delayed assistant speech pulling the visible session back to the call, and upload completion sending text to a newly selected session. Removed incoming-speech navigation, invalidated stale upload submissions, and bound model focus commands to the still-current foreground run and untouched composer. Source fix: 086a74ba5d499f74d1829978291eeadeb22848f5. Website mirror synchronized.

Live seeded Chrome proof passed before integration and again after inbox/routing trunk sync: selected session/draft/call binding preserved; next Send recorded only in the selected session; current valid focus accepted; background/stale focus and partial focused creation refused; upload navigation sent nowhere and preserved the new draft. Zero page errors. Voice callbacks and transport/upload completion were controlled, with no paid model or physical microphone used.

Validation receipts:
- Full repair candidate: fast 734/734, HTTP 106/106, customer journeys 33/33, exit 0.
- Synced candidate 0d99faf75: complete npm run test:fast 734/734 and npm run test:http 107/107, both exit 0; repeated live proof passed.
- Later independent image-intent sync 33f726cae: image-task 55, image-task e2e 63, browser 306, station-tools 67, station-commands 135, claims ledger 64 assertions and session-focus-safety all passed. These are incremental checks, not a new full-gate invocation on that later tree.
- Bug register validates: 87 records. Diff/syntax checks passed. No shared contract or credential migration changes.

The unchanged loop/git fixture initially failed under load, then passed alone and in both full HTTP reruns. No unrelated loop fixture change was made.

Proof: qa/evidence/session-focus-0909.json; repeatable runner: scripts/qa/session-focus-live.cjs; customer record: qa/bugs/774641dc-agent-session-focus-commands-can-unexpectedly-re.md. No installer build, push, release, or customer recovery is claimed.
