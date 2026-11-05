# Automatic steering verification — 2026-11-03

Branch: `agent/auto-steer-1103`. Integration base: `01814e440`.

Acceptance: submit a normal message during work, observe its delivery to the same run without a steering button,
receive a status answer, and observe further tools completing the original objective. Files and line breaks must
survive delivery and reload; Stop must not launch retained messages.

- `test/auto-steer.test.js`: lossless transport; early, between-tools and final-stream steering; status continuation;
  cancellation; ordered uploads/messages; connecting; duplicate POST; closed-run fallback; Stop during POST;
  repeated identical messages; durable history; later-turn user context.
- `test/auto-steer.e2e.test.js`: real HTTP sidecar, attachment expansion, original report written after a progress
  answer, idempotent applied receipt after completion, and durable receipt after sidecar restart. PASS.
- `scripts/auto-steer-live-proof.mjs`: `node dev/seed.js --keep`, isolated browser/profile and local scripted provider;
  normal COMMS sends, one run, zero steering buttons, status answer then report write with reference file,
  exact multiline messages shown once after reload, user messages retained in next-request context, zero JS exceptions.
  PASS. See `live-proof.json`.
- Focused legacy steering, receipt ledger, history merge, direct-channel reply, remote-core and host-fence tests pass.

The first broad fast attempt exposed unregistered host-fence tags and an outdated generated website mirror;
both were corrected. A clean complete fast gate and the complete HTTP gate are pending.
This is source/browser proof with deterministic provider responses, not live GPT/Claude or installed-app proof.
No publication or release was performed.
