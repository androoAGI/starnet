---
fingerprint: 64563ad9
slug: a-lost-race-consent-tap-stamps-allow-once-onto-t
title: A lost-race consent tap stamps "▸ ✅ Allow once" onto the message before resolveConsent is asked, so a DENIED request keeps a permanent "approved" record
surface: channels
severity: P1
status: fixed
found: 2026-07-28
lane: sweep/channels
fix: 96fe108d
---

# A lost-race consent tap stamps "▸ ✅ Allow once" onto the message before resolveConsent is asked, so a DENIED request keeps a permanent "approved" record

## Symptom

The Commander taps an approve button on Telegram a moment after the consent timeout fired. The button toast reads "✅ Allow once", and the permission message itself is permanently rewritten to end with "▸ ✅ Allow once" — the buttons stripped, exactly as if the grant had landed. The run was denied. A separate follow-up message says it expired, but the permanent record of the security decision, the thing a Commander scrolls back to, states the opposite of what the harness did.

## Repro

Ran a probe against the real hub + the real sidecar/consentwait.js (scratchpad/probe-expired-tap.js, mirroring test/channels.buttons.test.js case 5E): chat 555 with {approvals:true}, host consent timeout 20ms, runOnce awaits o.prompt for fs.write, then tap the first callback_data late. Output: `decision the RUN actually got: "deny"` / `ack toast: ["✅ Allow once"]` / edit applied: `"🔐 Permission needed\n\nfs.write  (write)\npath=notes.md\n\nIf you don't answer, this is denied and the run moves on.\n\n▸ ✅ Allow once"`. Same for a tap after E-STOP or after a superseding message — every path where resolveConsent returns false.

## Evidence

`sidecar/channels/hub.js:1117`

**Mechanism (read from the code):** onCallback stamps the message BEFORE it asks the host whether the decision was still live. Line 1111 `await ack((/^[\p{L}\p{N}]/u.test(shown) ? '✓ ' : '') + shown);` then line 1117 `try { await editMessage(chatId, entry.messageId, String(entry.meta.text || '') + '\n\n▸ ' + String(opt.display || opt.value), {}); } catch (_) {}` — and only afterwards, at 1120-1125, `if (entry.kind === 'consent') { let done = false; try { done = !!resolveConsent(entry.meta.runId, entry.meta.promptId, opt.value); } ... if (!done) { deliver('⚠ That permission request had already expired — the action was denied and the run moved on.') } }`. The edit's own comment calls it "Cosmetic ONLY" and says the transcript should "read as a record instead of a dead control" — but the record it writes is the button the human pressed, not the decision the broker applied. The stamp and the ack both belong after the resolveConsent result is known.

**Existing test coverage:** test/channels.buttons.test.js case 5E ('a tap that lost the race is reported honestly, never as a success', line ~392). It passes VACUOUSLY for this defect: it stubs `editMessage: () => Promise.resolve({ ok: true })` without recording, never inspects `acks`, and asserts only `sends.some(s => /already expired/.test(s.t))` — i.e. it checks the follow-up correction exists, never that the original message wasn't falsely stamped.

**Adversarial verdict (survived refutation):** Code reads as claimed. sidecar/channels/hub.js:1110-1111 acks with the button's own label, hub.js:1116-1118 edits the original message to `entry.meta.text + '\n\n▸ ' + opt.display` — both BEFORE hub.js:1120-1126 asks resolveConsent whether the decision was still live. entry.meta.text is really set for consent asks (hub.js:322), and editMessage is really wired in production (sidecar/index.js:5471 telegram, 5678 multi-bot), so the stamp is not a test-only artifact. I ran the real hub + the real sidecar/consentwait.js (scratchpad probe, 20ms consent timeout, late tap): `decision the RUN got: "deny"` / `acks: ["✅ Allow once"]` / the edited message ends `…▸ ✅ Allow once`, with the '⚠ … already expired' correction sent as a SEPARATE later message. So the permanent record of the security decision contradicts the decision the broker applied. The existing guard, test/channels.buttons.test.js case 5E (~line 392), does stub `editMessage: () => Promise.resolve({ok:true})` with no recorder and asserts only `sends.some(s => /already expired/.test(s.t))` — it locks the follow-up correction and cannot see the false stamp, so it is not a refutation. Mitigation that keeps this off P0: the harness fails CLOSED (the action really was denied) and does post an in-band correction, so the chat read in order is not deceptive — only the scrolled-back message is.

_Found by the `sweep/channels` lane, 2026-07-28. Finder confidence: high. Severity claimed P1, after refutation P1._

## Verdict

Fixed in `96fe108d` (2026-07-29; an ancestor of trunk, in every release since v0.8.0). The hub settles the consent with resolveConsent FIRST, then acks and stamps the message with the outcome the broker applied, so a tap that lost the race is never recorded as a grant; the separate "already expired" notice still follows. Regression: test/channels.buttons.test.js case 5E now inspects the stamp and the ack, not only the follow-up (passes on this tree). Reconciled 2026-10-27 (reliability wave 1, quick win 37).
