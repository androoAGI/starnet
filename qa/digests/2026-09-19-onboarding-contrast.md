# Onboarding sign-in code contrast — 2026-09-19

Owner requested merging the code-visibility repair reported during local onboarding.

- Source fix: `51dcb517d`; website mirror: `356f5bc66`.
- Trunk baseline: `eaac6fc97`.
- Synchronized candidate: `a31b27e43`.
- Integration: `9ef5b7e61f97e2180dfcc626c84b541b7100bf86`; candidate and merged trees are identical.
- Pre-merge full fast: **829/829 PASS**.
- Post-merge full fast at the integrated commit: **829/829 PASS**.
- Live production-stylesheet browser check: both onboarding code boxes render bright theme text at opacity 1 in amber, green, blue, purple, red and white. Verified again after synchronization. The original screenshot was dark text on dark glass. Sample codes were used; no credentials are recorded.
- Customer journeys previously passed **38/38**; current full gates include mandatory customer-journey scenarios.

The first integration-candidate gate correctly rejected an untracked visual fixture in frontend because it lacked a website mirror. The fixture was moved into the owned test-artifact directory, the parity regression passed, and fresh complete pre/post gates passed with unchanged product source.

Logs retained in `C:/Users/andro/gen-trees/onboarding-test-0919/.onboarding-test/merge-pre-fast-final.log` and `merge-post-fast.log`. The worktree and local server are retained for the owner's onboarding test. Existing trunk operational edits were preserved. No installer rebuild, push or publication. Installer acceptance and owner retest remain unverified.
