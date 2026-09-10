# Probe archive

These are copies of the audit probes with normalized LF line endings, not product code or registered tests.
They use synthetic inputs and local services. Preserve the directory layout when rerunning:

1. Use an isolated StarNet worktree at the recorded commit and install its dependencies.
2. Copy the .cjs files to a root `.audit/` directory.
3. Clone official Hermes tag `v2026.9.7` into `.audit/hermes`; copy the .py files there.
4. Use a Python environment with Hermes dependencies plus pytest, pytest-asyncio and jsonschema. Set `HERMES_HOME` to a new audit-only directory before Python imports; never use the real profile.
5. Run `node .audit/schema.cjs` and `node .audit/partial.cjs` from the StarNet root.
6. Run `node .audit/live-seeded.cjs` for the UI/JSON-format fixture. This stays running. The generated `.audit/live.json` identifies its URL and seed process.
7. With that server running, run `node .audit/idempotency.cjs`. Count primary requests by exact last user message in `.audit/requests.json`, not the total request delta: auxiliary skill review adds requests. The raw idempotency probe intentionally preserves the original total delta; the receipt corrects the denominator.
8. From `.audit/hermes`, run `probe_audit.py`, `probe_http.py`, and `probe_format.py`. HTTP probes inject agent results into real production routes; they are not live-model evaluations.
9. Inspect the UI normally, then stop only the fixture processes you launched. Run `node .audit/receipt.cjs` after the named evidence logs exist.

The receipt's aggregate test counts describe the original recorded run, not a new run. Update them when changing the selected tests.
