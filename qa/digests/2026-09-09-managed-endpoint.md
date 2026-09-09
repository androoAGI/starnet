# Managed endpoint repair — 2026-09-09

agent/managed-endpoint-0909 -> integration 1cd4e378f. Source fix 177a9384e; regression/ledger 739a004fd. The merge commit tree exactly matches the verified branch tree. The existing qa/STATUS.md and Rooms handoff edits were hash-checked unchanged; this separate digest avoids overwriting their owner.

A valid saved StarNet link succeeds, but a per-request closed-localhost baseUrl on the original code reproduces the customer's exact fetch failed (ECONNREFUSED 127.0.0.1). Managed requests now resolve their linked endpoint and credential before any request overrides. Custom routing is preserved. The original resolver ordering was also checked in v0.10.13; no released-installer reproduction was performed.

Evidence:
- Baseline real-sidecar reproduction passed with ENDPOINT_BASELINE=1 before the fix.
- Patched real-sidecar test passes stale baseUrl/base_url, wrong request key, custom -> managed switching, desktop-token restart, and rejection of unlinked managed access before any provider call.
- Real Harness storage logic confirms normal switching does not copy custom endpoints to Gemini/StarNet; an already-saved managed override survives reload. Its origin on the customer's device remains unknown.
- The same routing journey passed via node dev/seed.js --keep using a temporary wrapper and disposable profile. Wrapper removed afterward.
- Syntax and diff checks passed; bug ledger validates (85 records).
- Complete fast manifest: 733/733 green via the unchanged test:fast:raw runner with a 30-minute outer budget. The standard npm run test:fast wrapper first hit its 15-minute limit, without an assertion failure.
- Complete HTTP manifest: 107/107 entries verified in order. Initial run failed at loops.e2e due WORKSPACE_BUSY during test restart. That test passed alone and in the full rerun. The rerun passed entries 1-85 before its 15-minute wrapper expired; the same manifest runner then passed entries 86-107 (22/22). This is segmented completion, not a claim that the ordinary timed HTTP command exited successfully.
- Logs retained locally in the isolated worktree: .endpoint-fast-full.log, .endpoint-http-retry.log, .endpoint-http-tail.log, .endpoint-loops-retry.log, .endpoint-target.log, .endpoint-seed.log.

All account/provider fixtures were synthetic. No production service deployment, live vendor billing call, signed-installer upgrade, or customer recovery was verified. This patch fixes a demonstrated application defect matching the report. It does not establish that Mike's destination came from a per-request override rather than the saved linked service URL, an operator override, or DNS/hosts redirection.
