# Memory correction and incomplete-run repair

Customer report: explicit corrections were forgotten or competed with old memories, approved designs drifted, and runs stopped after promising further work.

The source repair replaces corrections in place with revision history and stale-write protection, preserves scoped approved requirements through recall and compaction, carries recalled pinned requirements into delegated context, and reports detected unsupported memory-save claims or exhausted action promises as incomplete runs. Reflection proposes reviewed replacements instead of silently discarding opposite preferences.

- Baseline reproduced at `87e10e1fe`; final production-source change: `46c929a88`.
- Integrated `agent/recall-report-0916` into `feat/harness-backend` by fast-forward from `1edb652f712e7d24d45888e32189544f486a603e` to `dcc1dc27f8e051bd187f5fb1f2ed1c48f9490788`.
- Integration was byte-identical to the tested candidate. Existing dirty `docs/NEXT.md` and `qa/STATUS.md` were hash-verified unchanged by the merge.
- Before integration: full fast gate **813/813**, full HTTP gate **119/119**, customer journeys **36/36** passed. The final recency follow-up also passed the affected focused and seeded HTTP checks.
- Post-integration fast gate: **813/813 passed**. HTTP gate: **119/119 passed**. Both full commands exited 0 on the integrated source.
- Syntax and new-symbol checks passed for the merged loop, memory tool, and server composition. Shared event/schema contracts and credentials were not changed.

Live proof used an isolated `node dev/seed.js --keep` station with a deterministic local OpenAI-compatible provider. The actual MEMORY panel showed old → new requirements; clicking Keep left one active corrected pinned memory. The corrected memory and pending review metadata survived restart; a delayed review could not overwrite a newer edit. See [verification.json](verification.json) and the two linked bug records in `qa/BUGS.md`.

Raw local gate logs and seeded-run receipts are archived at `C:\Users\andro\gen-trees\recall-report-0916-receipts`. The final follow-up commit adds only this verification digest; production source remains identical to the integrated tree tested above.

This validates the harness behavior, not arbitrary commercial-model responses or visual design fidelity. The customer's exact model/build/transcript was unavailable, so customer recovery remains unconfirmed. No installer was rebuilt, installed desktop binary validated, or public release made.
