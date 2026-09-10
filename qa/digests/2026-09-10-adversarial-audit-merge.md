# Adversarial audit integration — 2026-09-10

- Branch: `agent/adversarial-audit-0910`.
- Previous trunk: `c17a38d8f1003959e2764d4e9c37f180c11a1d0d`.
- Runtime merge: `18817ae0fa3819e536ba1bd19fcaab0ce902cffd`.
- Premerge candidate: `4dfbaee6f27de083a99e138779f8985ba7d3f18a`; fast 762/762, HTTP 110/110, customer journeys 34/34, all exit 0.
- Postmerge exact runtime: fast 762/762 and HTTP 110/110, both exit 0.
- Fixed P1 bugs: `bb24585f` concurrent review/Git undo inconsistency; `7546cccd` stale-window station overwrite; `408a0794` lost attachments during group conversion.
- Live proof: two-window conflict and recovery UI; group attachment opens with original bytes; real Git review race; persistence after sidecar restart. Final combined-source restart and changed conversion retry verified.
- Existing QA notes and Rooms handoff preserved; no foreign changes staged. Only evidence documents follow the tested runtime.
- Disposable audit services stopped and temporary browser tabs closed. Raw evidence retained in the audit worktree; it was not removed because untracked audit logs remain.
- No deployment, installed desktop rebuild, real-provider billing or account recovery claimed.

Full report: `qa/audits/adversarial-2026-09-10-fixes.md`. Gate receipts and hashes: `qa/evidence/adversarial-0910/combined-gates.json` and `postmerge-gates.json`.
