# Final support intake for 0.12.0

Reviewed September 16, 2026, after the earlier preparation snapshot. Gmail became available in this task, superseding the earlier note that private inbox access was unavailable. The scoped search for StarNet messages after September 11 (excluding sent, drafts, spam and trash) returned 11 inbound messages across nine threads, all after the September 11 20:16 UTC publication of 0.11.2. Public repository issues were refreshed as well. The new comment on issue #17 discusses setup guidance; it does not provide a latency retest or confirm recovery.

No support messages, refunds, account changes or issue-closing actions were performed. Customer identifiers and private diagnostics are excluded from this document. Source inclusion, installer verification and customer recovery remain distinct outcomes.

| Report | Disposition |
| --- | --- |
| Ollama request reportedly never reaches the server | New open P2 `5274c7b7`. The shipped Node 22.23.2 and production provider factory successfully send four real HTTP POSTs after discovery to a controlled local server, including a 128 KiB context. This does not reproduce the customer's Ollama 0.5.7 environment or establish recovery. |
| Mac reports unsupported application | New open P2 `ff3fb4cb`. Exact OS, architecture and downloaded asset are needed. Separate signed architecture builds do not prove this customer's recovery. |
| Unspecified inability to see usable content | New open P2 `6bb9d2a1`. No build, screen, platform or diagnostic was supplied. Do not invent a graphics diagnosis. |
| Credits consumed while Mac boot failed | New open P2 `abd75bb4`. Requires authoritative account/run correlation; no accounting adjustment was performed. Keep it separate from the older unrelated idle-usage report. |
| Workbench present in interactive runs but absent in Product Lines | `4a19c050` documents the current deliberate scope restriction. Standing interactive approval does not grant unattended line authority. An explicitly granted scheduled routine is the supported scoped unattended path; no new Product Line permission feature is promised. |
| OpenAI image model selected for chat | Source-fixed `6c6c34e1`, repair `7a9349aa071c8fd97f04b520333d37d821f55c69`, already included in immutable 0.12.0. Studio/native image transport and saved output are covered by regressions. Customer recovery and exact installer behavior remain separately unconfirmed. |
| Mac shared catalog boot failure, with a separate Windows Edge report naming the same module | Existing `2f156837` retains the included BootGuard hardening. The Mac reporter now confirms the installed app and continued failure on the public build. This is not a retest of the unpublished candidate. The Windows report's full origin is unknown. |
| Purchased credits remain on a different account; unlink does not expose relinking | Existing `99a1517b` includes source recovery fixes. The owner had already correlated the purchase to the other account. No new successful reporter retest was received. |
| Moving a station to another computer | Support/documentation question, not a demonstrated defect. Preserve the existing station and use documented backup/export and restore; no customer machine was modified. |

The updated register has **83 customer/owner records: 76 source-fixed, one documented policy disposition, and six open P2 investigations**. No open P0/P1 is established by this intake. The four new P2 records preserve uncorrelated uncertainty under the owner engineering-acceptance rule; they are not fabricated fixes. The earlier two-P2 summary is superseded.

This intake update changes records only. The application candidate remains `df6090835dcdebc402356466fc54a48f929ff942` (`v0.12.0`); the release pipeline uses a separately pinned CI-only cleanup repair. Do not move the application tag for support-note updates. Final installer, Mac acceptance and fresh-machine receipts must still pass before the prepublication handoff.
