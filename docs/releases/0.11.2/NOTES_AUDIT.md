# 0.11.2 release-note expansion

The owner requested complete, organized notes after publication. The former 20-bullet summary omitted substantial shipped features and compressed unrelated repairs. `RELEASE_NOTES.md` now groups the shipped changes into ten sections, with specific behavior and relevant limits.

Scope is immutable `v0.11.1` (`b3760c46ff3fe02790e6c3b0c50a23c30b5837a8`) through `v0.11.2` (`69baf91a5b2c22230f87e614da6a72882278bc6c`). Reviewed all non-merge product commits, first-parent integration history, final runtime/style/asset differences, API documentation, the original merge audit, and release/installed verification receipts. `notes-scope.json` retains the complete commit and changed-path inventory; overlapping synchronization merges are not counted as independent features.

| Notes section | Source anchors and scope |
| --- | --- |
| Station visuals and performance | Backdrop final artwork c772f4f84, worker/cache repair 2c041bbe6, CRT d9477feb6, walks c24077948, directional correction 734063b21, panel persistence 871561348, transient cards 19fc72df4/25b32523d/455ffc9ed. |
| Overseer and personalities | Setup 70a698ad2/0946764a5, personality 81b6f5703/a29342efc/f7be913a6, narrow layout ff188bee7, stale-warning recovery 564c399fd. |
| Providers and discovery | Discover 4e1d06c00, guide 59a5b1e22, GitHub 16cf2b926 and subsequent expiry/error/persistence fixes, identities 3f2cc70d4, catalog 59b5f2462, fallback/MCP 44c6b4952/b4bcdac90, Claude f111be488/9441660d0. |
| Saves and recovery | Concurrent save and loop reviews 64ed8711b, conflict-arrival bb1aa021e, startup eab106abd, conversion de01a1343, queued revision 767a35925, restored replies a66fc5638. |
| COMMS and feedback | Report rendering 6974ac3f8, source copy 19e6aebde, list repair cb6c30b4d, failed X 407ac8433, truthful outcomes f952835ab. |
| World behavior | Doorways a22f780e3, look-back 75a814c18, desk/refit 774a5eeed, lifecycle/approval 35d255dbd, wakeup sequence 33cdb8137. |
| Images and speech | Charges/cancel d503f00c5, cleanup f9750306d, output recovery f129e19e3; image recovery wording is included in the image repair. |
| API and automation | Durable retries/result contracts 94e3d17ba, streaming b6f090872, repair bounds 74c31814b/ca55157ee/61eeac2b4, listener diagnosis 4d5ee74c1, paused routine b87bdf260. |
| Desktop and diagnostics | Pointer dd85573b9 (merge 33c925797), native identity bed625bdd, Linux fbaab109f/bbbd7c13a, redaction 0a3a605a9, corresponding website mirror. |
| Validation | Frozen release and post-public receipts in PUBLIC_RELEASE.md; QA timing 5262e4a29/88c009223, catch-up accounting 7efce3552, installed/soak distinction b9c553955. |

The reverted experimental Night City cloud/highway/stadium pass is not advertised. Superseded Forest intermediate designs are summarized by the final shipped artwork. Five historical engineering closures are not misrepresented as five newly introduced 0.11.2 fixes: their earlier fix commits predate this comparison. Three investigations with unconfirmed causes remain follow-ups.

## Publication surfaces

The same complete notes replace the distribution release body, source release body, and the `notes` field of the published `latest.json` consumed by Update Center. Before mutation, the existing bodies and manifest are backed up locally. Every manifest field other than `notes` must remain equal, including version, publication date, platform URLs and signatures. Published installers, signatures, source tag and historical evidence receipts remain unchanged.

The shipped Update Center intentionally truncates its inline preview to 520 characters (`shortNotes` in `frontend/app/updates.js`). Updating the feed supplies the complete text but does not change that installed renderer; the public release pages show the full organized notes. Expanding the inline renderer would require a subsequent application build and is outside this documentation amendment.

Original publication receipts in `qa/evidence/0.11.2-public-release-0911/` deliberately retain the original short body and original manifest digest. Their bytes describe publication-time evidence. The post-publication documentation amendment is tracked separately here; it does not relabel or rebuild the shipped executable.

Validation for this amendment: source coverage review, Markdown structure/link checks, exact remote body/notes readback, unchanged non-notes manifest fields and installer asset identities, and the repository-required fast gate before integration. Final operational results are appended to NEXT/STATUS and retained under the owned worktree's `.dogfood/release-0112-notes/`.
