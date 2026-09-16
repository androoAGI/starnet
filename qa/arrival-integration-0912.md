# Arrival integrated into the local app — 2026-09-12

Source candidate: cfd8cb9a2, agent/onboarding-conversation-0912. Upstream through b4652157b
was merged into the isolated lane before these changes. No shared-trunk merge or release is claimed.
The integration checkout had other active tracked edits when checked.

## Behavior

The real station now expands to the viewport during the 24-second arrival. At first contact,
the arriving agent's own name appears, then fades with the effects. The normal station layout
returns before the interview. Skip and cancellation also restore the layout and cancel the
camera tween. Reduced motion remains six seconds, without the camera push.

## Proof

- Real application at 9011, local replay provider: created NOVA and invoked Wake Overseer.
- During FIRST CONTACT, DOM showed NOVA and title opacity 0.996983. Canvas bounds were
  x=0, y=0, width=1280, height=720, matching the entire viewport.
- On completion, both arrival DOM overlays were absent; canvas returned to x=252, y=84,
  width=648, height=572. The interview displayed Get acquainted / Choose your pace with
  quick setup, short conversation, and longer conversation choices.
- Browser error log was empty.
- Registered arrival tests cover deterministic rendering, bounded timeline, skip, stale
  callback cancellation, title cleanup, cancelled camera tween, reduced motion, and lighting.
- npm run test:fast: 772 steps green, exit 0. Log: .arrival-integration-fast.log in the lane.

## Live owner entry point

http://127.0.0.1:8992 serves this lane's real frontend and sidecar. It uses a fresh onboarding
workspace, with the previous station preserved in its original location and in the lane's
.dev-workspaces-8992-saved-preserved directory. The existing provider credential was copied
into the new workspace and read-back verified without removing the source. The UI showed the
existing ChatGPT connection, GPT-5.5, and NOVA. It was left at Wake Overseer for the owner.
No real provider completion, installed desktop build, or shared-trunk integration is claimed.
