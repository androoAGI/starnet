# StarNet v0.10.10

- Fixed several StarNet account and credit edge cases: funded accounts no longer fall back to stale or zero balances, temporary reservation holds no longer trigger false out-of-credit warnings, and failed or timed-out account reads remain clearly unverified instead of inventing a balance.
- Account recovery is more dependable. Revoked or incorrect links return to a usable relink flow, and **START COMPLETELY FRESH** can retry browser-state clearing without quarantining the newly cleaned station again.
- The **KEYS** panel now distinguishes a refused or unreachable station from a genuinely empty key list, so transport failures cannot appear as saved or held credentials.
- Fixed a rare permanently black station viewport after a WebView/GPU canvas-context loss; StarNet now rebuilds the visible stage and rewires its input automatically.
- Fixed dead clicks in **OUTBOX** caused by tiny pointer jitter, and widened the clickable area around shipped pallet crates.
- Added tighter time bounds around account-link and balance responses so a stalled response body cannot leave the station waiting forever.

This bug-fix update waives the normal 48-hour RC soak because it repairs active account-access, viewport, and interaction failures. The exact installed-desktop smoke, full fast/HTTP gates, signed release train, and hosted T0/G1 packaged checks are still required before publication.
