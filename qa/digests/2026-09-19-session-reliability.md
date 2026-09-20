# Session reliability — 2026-09-19

Integrated `agent/session-reliability-0919` at `bed9aaf53bee145aeb12420a5d34c66985f34d77`. Accepted candidate `78fcef689` and merged trees are identical. Work ran in the clean, owned `chat-cutoff-0919` worktree after creating a second checkout failed for disk space; no other lane's workspace was edited.

The live baseline on `8e182efaf` reproduced two defects: delayed history updated the saved thread but stayed invisible (`delayedVisible:false`), and a follow-up dispatched before restored context arrived (`beforeHistoryReady:1`, `modelContext:false`). Per-session read ownership now separates restoration from scroll-pin lifetime, discards obsolete writebacks, renders late history, and holds inference until context restoration succeeds. Failed restoration keeps the user turn and offers an explicit retry. The bounded timeout uses AbortController for older browser compatibility. Both shipped frontend copies match.

Mandatory fast/customer campaigns now exercise 48 controlled ownership/lifecycle sequences and a real seeded browser journey combining delayed restore, changed context, background delivery while typing, send/switch, failed reads, one explicit retry, interrupted output, failed durable save, successful save, cache removal and sidecar restart. COPY DIAGNOSTICS includes the last 64 page-local continuity events without conversation text, titles, paths or durable session IDs. Windows candidate upgrade acceptance is wired to run the journey against hashed installed files and the installed Node runtime.

| Verification | Result |
| --- | --- |
| Full pre-merge fast gate, Node 24.19.0 | 822/822 PASS |
| Full post-merge fast gate on `bed9aaf53`, Node 24.19.0 | 822/822 PASS, completed 15:12 America/New_York |
| Full HTTP gate, Node 22.23.0 (CI major) | 119/119 PASS |
| Customer journeys | 38/38 PASS |
| Independent final fast-gate slice | 87/87 PASS |
| Deterministic session lifecycle sequences | 48/48 PASS, desktop and website |
| Live combined journey | PASS, including confirmed-save recovery after cache removal and process restart |
| Node 22 live journey and alternate bundle-entry runner using source files | PASS; runner validation, not installed-artifact proof |
| Existing history/order, stream completion, focus/typing and diagnostics checks | PASS |

Receipts: [baseline](../evidence/session-reliability-0919/baseline.json), [live verification](../evidence/session-reliability-0919/verification.json), [acceptance contract](../SESSION_RELIABILITY.md), [bug 2426399e](../bugs/2426399e-reopened-conversations-send-before-history-is-re.md). Full logs remain in the owned worktree's `.dogfood/session-reliability-*.log` files.

Initial gate attempts exposed obsolete source-shape assertions and the new test's missing repository result reporter; both were corrected without weakening behavioral assertions. The Node 24 HTTP attempt and isolated recheck passed update-preparation's nine assertions but hit Windows libuv's `UV_HANDLE_CLOSING` assertion during test shutdown. The unchanged test and complete HTTP gate passed under CI's Node 22 major. No production workaround was added for that test-runtime failure.

No installer was rebuilt, installed or published by this lane. Windows installed-bundle wiring is future acceptance, not a passed artifact receipt; native Windows WebView and physical macOS verification remain required. The model transport is simulated, so this proves the browser's model-bound context rather than external model recall. Original customer/build correlation and recovery remain unconfirmed. Deliberate clear/undo across a later reopen and multi-device conflict resolution are outside the new in-flight-clear scenario; existing tests retain their separate scopes. These repairs and gates do not establish that all session defects are impossible.
