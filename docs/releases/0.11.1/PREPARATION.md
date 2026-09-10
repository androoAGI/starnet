# Urgent 0.11.1 release preparation — 2026-09-09

PREPARATION ONLY. No version bump, release tag, installer build or publication has been performed by this lane. The adjacent RELEASE_NOTES.md is a draft; copy it into the root release notes only during the ordered cut, after reconciling the final merges. Do not publish this operator handoff as customer notes.

## Verified baseline and scope

Public distribution latest is v0.11.0, published 2026-09-07T19:09:09Z. Source tag v0.11.0 exists. Live GitHub checks found no local/origin v0.11.1 tag and no distribution release with that number. Recheck immediately before cutting. Old drafts v0.10.0/v0.10.1 are unrelated; leave them alone.

Preparation began at trunk 209ce13579ba919329d96886ed1c0b2e9997ecfe. Glass then landed as c275727ea and was synchronized into this isolated lane. Final merge SHA is still pending; no earlier test receipt proves later code.

| Required change | Verified source | Release treatment |
| --- | --- | --- |
| Managed linked endpoint / token repair | 177a9384e, merged 1cd4e378f; bug 3195ab5a | Mandatory ancestor of final release. Source/live-sidecar recovery proven; installed/customer recovery unverified. |
| Managed image credits | 050e1eec5 | Included on baseline trunk. |
| Saved equipment/tool projection | 793bf1c0f | Included; related Trusted Project customer symptom still open. |
| Voice continuity | ab1cd74be | Included; do not claim customer acoustic recovery. |
| Session focus / image intent | 60e2042a3 / 407b82b4d | Included. |
| Legacy ratings | a55a1ed07 and subsequent integration | Included. |
| World and starter shell | 0656a655e / f68403588 | Included. |
| Glass and window interactions | c275727ea | Landed during preparation. |
| Remaining menu/recipe work | observed agent/recipe-library-purpose-0909 at f49a20d66 | Still incoming at this check. Freeze its FINAL tip and confirm ancestry before including the note below. |

The likely incoming task is "Optimize deliverable purpose"; the glass task is "Expand glass UI identity". Branch identification is from the live registry/history and remains subject to the owner's clarification. Do not take over their integration or move their branches.

Provisional additional bullet, only after the remaining work lands and passes acceptance:

> Recipe Bay and station menus have clearer workflows and controls, including recruitment, abilities, settings, agent profiles, quests, channels, automation and task outputs.

Read the final diff and replace this broad bullet with the actual shipped behavior. Do not advertise every subtask in a long-running conversation as included merely because its task title mentions it.

## Customer-fix boundaries

Bug 3195ab5a reproduces a real stale per-request endpoint defect and is fixed in source. Mike's report does not establish how localhost entered his settings. The separate historical managed-Sonnet HTTP 400, fd9c4b4d, remains open. Do not claim that v0.11.1 resolves all his failures or that a successful mock-provider test establishes production recovery. Required final check: installed candidate, linked funded test account, intended managed model, successful real run; retain sanitized request IDs if it fails. No customer communication or account mutation is part of this preparation.

## Proof already obtained

- Initial preflight: all five version pins agree at 0.11.0; v0.11.1 is unused; claims lock current for 209ce1357; website mirror in sync; updater key exists (contents never read).
- Live public updater verification with --expect-version 0.11.0: ALL CHECKS PASSED. Windows x64, Mac ARM64 and Mac x64 manifest entries and version-pinned asset URLs were reachable. This verifies metadata/signature presence, not cryptographic installation.
- On source 209ce1357: six existing test files, seven Node test entries passed, zero failures. Backup secrets 44 assertions; workspace migration 31; legacy rating upgrade 24; installer upgrade resilience 30; historic 0.8.5-to-0.9.0 compatibility 40; managed endpoint tests exercise actual sidecar runs, stale URL/key overrides, custom-provider switching and restart with a synthetic desktop token. Logs: release-upgrade-checks.log in this worktree.
- On c275727ea, the complete customer-regression campaign passed: run-test-list: OK — 34 step(s) green, exit 0. It includes real sidecar restart/recovery, managed-image billing against a simulated service, session focus and ten tool-projection runs with file writes. Log: release-customer-journeys.log. The mandatory managed-endpoint test was run separately above.
- These are source/contract proofs using disposable profiles and simulated upstream responses. No old-to-new installed 0.11.1 upgrade has been tested yet. No real user profile was modified.
- Dependencies are installed in this worktree. Preflight log: release-preflight-initial.log. Full fast/HTTP gates must run after the final version/notes/claims commits, not be reused from this preparation.

## Actual blockers, not just worktree-missing artifacts

Trunk qa:ready at 209ce1357 returned NOT READY at 2026-09-09T23:47:22Z:

1. Machine ledger: 1 P0 and 3 P1 findings. 9c208e00 is an older fast-gate timeout; 5c2a7626/b30906c8 are panel-close cancellation/stream-close failures; f373c745 is build-connectors opening. Fresh passing targeted evidence can support reconciliation; do not dismiss them solely because they are old.
2. Customer register: seven open P1 records: acb47320 (idle/usage), c2a6c3c8 (ONCE routine visibility), eaaa3ec8 (Mac paid onboarding), 72af29f4 (zero-credit warning), fd9c4b4d (Sonnet 400), 432df352 (equipment/Trusted Project), 9256a771 (blank viewport). Preserve unresolved customer state.
3. Guardian latest cycle RED. Its latest fast/HTTP gates passed, but golden exited 3. The inspected .bugloops/guardian-20260909-230002/golden.log lists 12 changed frames awaiting visual review (four other differences already matched known/dismissed findings). Review the approved redesign against these differences; do not blindly accept a new baseline.
4. Journeys passed 139/139 on f672e33e, but do not cover the final head.
5. Beginner UI proof passed on ed768880, but does not cover the final head.
6. Installed smoke proves the old 0.11.0 build, not current trunk.

The release ritual hard-stops on NOT READY. Final merges alone do not clear these blockers. A prior 0.11.0 soak waiver is not automatically a 0.11.1 waiver; record the scope of any owner-directed expedited exception explicitly. Never manufacture READY, copy stale receipts, reclassify customer bugs just to pass, or silently bypass the release script.

## Shortest remaining execution sequence

1. Freeze after both intended merges. Record final branch tips and trunk SHA. Verify each required fix with `git merge-base --is-ancestor <fix-sha> feat/harness-backend`. Merge trunk into this lane without rebasing. Check final version collision and reconcile notes against `git log --first-parent v0.11.0..feat/harness-backend`.
2. Resolve/reconcile the named readiness blockers with current evidence. Obtain current packaged acceptance using the existing private-candidate path if needed; qa:ready requires a matching binary. Rerun qa:ready on the intended candidate. The new worktree lacks machine-local trunk receipts, so its empty ledger is not proof the trunk ledger is clear.
3. Use the existing release ritual/runbook; do not edit version pins separately. Run preflight for --version 0.11.1, then the ordered ritual. At its release-notes stop, install the reviewed adjacent draft as root RELEASE_NOTES.md and amend only the release commit while it is HEAD. Re-lock claims in its separate commit. On a lane use --allow-lane; tag belongs on the final trunk integration commit.
4. Run and retain fresh full test:fast and test:http logs after the final bump/notes/claims commits. Run the complete customer journeys, plus managed-endpoint.e2e.test.js explicitly (it is in HTTP but was not in customer-journeys.list at baseline). Earn gate receipts using the ritual's --gates-proven-by arguments. Merge serially per starnet-merge-ritual and earn any required final-merge receipts. Never use preparation logs as final-release receipts.
5. Push the verified trunk and new immutable tag together through the existing train. The last three successful trains took 23m31s, 29m16s and 27m37s; this is a planning estimate, not an SLA. Existing Windows train proof already exercises the latest and previous public installers and protects saved-state markers. Source src-tauri files were unchanged since v0.11.0 at the initial scope check.
6. As soon as the draft is staged, dispatch independent T0 and G1 jobs together:
   `gh workflow run t0-clean-install-proof.yml -R androoAGI/starnet -f tag=v0.11.1`
   `gh workflow run g1-packaged-lifecycle.yml -R androoAGI/starnet -f tag=v0.11.1`
   Require both green. Review all signed platform artifacts, latest.json, installer digests and Mac acceptance. G1 updater-smoke is read-only; it is not proof of a full upgrade.
7. On an isolated installed profile, preserve representative station state (crew, layout, themes, chats, ratings, linked account and routine settings), install the candidate, relaunch twice and compare state. Exercise the urgent managed run. Do not run lifecycle tooling against the owner's real station. Retain a whole-station backup and app version before any real-user update; never restore over a profile without protecting newer state.
8. Publish only after concrete final artifact acceptance and the owner's release direction. Then run `npm run release:verify-host -- --expect-version 0.11.1`, perform an actual older-client Update Center download/install/relaunch canary, and confirm the new version and preserved station data. The public check interval can delay discovery; the affected user can use CHECK NOW after publication. Run sync-source-release for prompt source-repository mirroring if needed.

Rollback: never move an already-built tag or overwrite a published installer. A pre-publication failure leaves the old public feed untouched. Follow RELEASE_RUNBOOK.md section 2 for a public-feed incident; installed newer clients generally need a higher patch version for recovery, not an assumed automatic downgrade. Preserve both pre-update backups and subsequent user work.
