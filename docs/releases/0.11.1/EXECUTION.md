# 0.11.1 expedited release execution

Owner authorization, 2026-09-10 UTC (2026-09-09 New York): after being asked specifically to waive the NOT READY aggregate and long soak while preserving open issues and requiring fresh fast/HTTP tests plus signed installer/upgrade acceptance, the owner replied: "I AUTHORIZE THE SKIPS PLEASE JUST GET THIS UPDATE OUT CLEANLY AND SAFELY AS NORMAL BUT MUCH FASTER WE NEED TO GET THIS OUT ASAP DONE RIGHT".

This authorizes the documented exception to the pre-cut READY aggregate and extended soak. It does not assert READY, close any customer report, or waive fresh fast/HTTP gates, release signing, installer acceptance, updater integrity or preservation of user data. Publication is explicitly authorized by the owner's release request once those remaining checks pass. No second publish confirmation is required.

Frozen feature integration: f26fb059e82b9858cdf9dcb25601e4b69da12872. Both glass and menu branches are included. Mandatory routing fix: 177a9384e6d7e62b5b93482c0d2dfbcde885b49f.

The preparation document and its receipt are historical observations, not final release acceptance. The final-merge pre-bump fast run was deliberately stopped after authorization so the binding run can occur after the version bump and notes/claims commits. It is not a passing receipt.

Use the runbook's manual ordered operations for this one authorized exception; do not modify the release gate to pretend it passed. Keep preflight output showing the real NOT READY result. Require every other post-bump hard preflight row to pass. Record final release SHA, test logs, train run, staged asset hashes, packaged acceptance and public-feed result before closing this release task.
