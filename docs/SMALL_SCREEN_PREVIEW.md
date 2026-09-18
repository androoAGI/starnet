# Small-screen COMMS preview

Lane: `agent/small-screen-0917`. Source preview only; installer and original customer hardware are unverified.

Open `http://127.0.0.1:8967/dev/comms-layout-review.html` with the lane's seeded sidecar running.
The review page embeds the real app, adds a representative production TaskConversation card,
and lets the reviewer toggle the new stylesheet, window size and text size. Sample-card submission
is local to the review; it does not represent a model run.

## Changes

- At constrained desktop widths (861–1440px) or heights (up to 740px), default COMMS width
  grows with the available width. Explicit divider sizes take precedence.
- Expand / Restore temporarily gives COMMS the workspace without changing saved divider
  widths, the crew visibility preference or unsent text.
- Task questions use one frame, compact starting-point rows and less padding. Reading-size
  tokens and question/answer behavior are unchanged.
- Short windows have a smaller identity bar and composer. Narrow stacked layouts give the
  conversation the flexible remainder instead of overflowing on enlarged text.

## Live evidence

Run `node scripts/check-small-screen.mjs` against the isolated sidecar on port 8967.
It launches an owned headless browser with the existing input-isolation bootstrap and closes
that browser after verification. Evidence is written to `.dogfood/small-screen/`.

Twenty combinations passed: 1366×768, 1280×720, 1024×600, 800×600 and 390×844;
each at 100% and the shipped HUGE 145% text setting; each in normal and expanded modes.
The checks read actual zoom, panel and composer bounds, transcript height and button reachability.
The live production question component accepted a starting point and recorded its submitted answer.
Expand / Restore retained 420px COMMS, 250px crew, crew visibility and an unsent draft.
The interactive review initialized and its Before/Updated switches changed the intended stylesheet.

At 1280×720 and STANDARD text, the same sample card measured:

| Measure | Before | Updated |
| --- | ---: | ---: |
| COMMS width | 360px | 486px |
| Question-card height | 535px | 353px |

Screenshots: `.dogfood/small-screen/before-1280.png`, `after-1280.png`, `expanded-1280.png`.
Original customer viewport, build, OS scaling and recovery are unknown. The preview uses a keyless
seeded backend; this layout campaign does not establish a real provider/model round trip.

## Final gates

Source candidate `b993d1410` passed `npm run test:fast`: **815/815 steps**, using Node 24.19.0.
`npm run qa:customer-journeys` passed **36/36 steps**. JavaScript syntax and diff whitespace
checks passed. Local logs: `.small-screen-fast-verified.log`, `.small-screen-journeys.log`,
`.small-screen-live.log`. The initial runs identified the required website mirror sync and
source-hash refresh; both were corrected before the complete green run. No claims verdicts
were changed. The worktree and preview server are retained for owner review; no integration
merge or installer build was performed.
