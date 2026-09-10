# Onboarding refresh — 2026-09-10

Lane: `agent/onboarding-refresh-0910`, based on trunk `2aa8305c0`.
Implementation: `70a698ad2`. Carries the earlier tutorial speaker repair as `d89e1d6e1`.

## Change

The opening wake beat is shorter. Creation shows the journey; the conversation offers
Quick setup (two questions), a shorter personal interview, or the full guided interview.
Quick setup saves a purpose and the chosen autonomy posture through the existing stores,
then hands off to the first task. A deeper profile remains optional later.

The dialogue has a solid reading surface, phase labels, a real Continue button, and a
multiline custom-answer field (Shift+Enter adds a line). The closing speeches are reduced
to one handoff. First-task suggestions fall back to the saved goal when there is no pain
profile yet. The website mirror is synchronized.

## Live evidence

Used the real sidecar/frontend through `node dev/onboard-mock.js --keep` on isolated
ports 19372 and 19373. The local mock supplies canned model replies: this proves UI,
request plumbing and persistence, not real-model response quality or paid authentication.

- Fresh NOVA creation reached the pace chooser through the revised wake sequence.
- Quick setup accepted the exact two-line purpose:
  `Turn my meeting notes into clear action lists.\nKeep owners and deadlines tied to the source.`
  Selecting Wait for me saved initiative `wait`, reach `observe`, leash 3.
- A real sidecar restart and browser reload retained that exact purpose, autonomy and
  `onboarded: true`; the ceremony did not replay. The station showed COMMS online,
  NOVA idle, and no conversation dialog.
- The first-task form selected meeting-note actions and quoted the saved purpose.
- The optional full interview opened, accepted a two-line custom answer, and advanced
  through its acknowledgment/Continue button to the generated follow-up question.
- At 1024x600 the interview dialog was 287px wide, with no horizontal overflow; its
  six options and custom-answer control remained reachable through vertical scrolling.
- A second fresh final-candidate pass chose Code & build and Decide later. Saved truth:
  purpose `Help me write, debug, and ship software.`, onboarded true, unchanged default
  posture `{v:1, initiative:"wait", reach:"sandbox", leashPerDay:3}`.
  It reached `FIRST TASK · YOUR STATION IS READY` with NOVA as speaker.
- Browser warning/error logs and native default-control paint scan were empty.

## Gates

- Syntax and focused dialogue/onboarding/first-task regressions passed.
- Customer journeys: `run-test-list: OK — 34 step(s) green`.
- First fast-gate attempt stopped at voice.button.test.js: the ordered retry had begun
  the last playback but its fixed 40ms observation window had not seen the final drain.
  Isolated rerun passed all 128 assertions. No voice implementation or test was changed.
- Second attempt stopped at shellhooks.test.js during temporary-folder cleanup with Windows EBUSY. Its isolated rerun passed all 50 assertions. No shell-hook source or test was changed.
- The next run passed voice and stopped at the stale candidate source lock. Refreshed only releaseSurface in commit `5e0ecc0f8`; the claims authority regression then passed all 64 assertions.
- Full fast gate on committed candidate `5e0ecc0f8`: `run-fast-tests: OK — 753 step(s) green` (exit 0).

## Scope of proof

Installed desktop behavior, paid-provider quality and completing every full-interview
branch were not verified. No real task was dispatched in this refresh proof. This lane
has not been merged or released; these checks do not establish station-wide readiness.
