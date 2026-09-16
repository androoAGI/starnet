# 0.12.0 owner soak waiver

On September 16, 2026, Andrew directed the 0.12.0 update preparation with: "we can skip the 48 hour soak entirely, but I want to have you definitely do a reliability and lag test on the new desktop installer when you build that, ensuring there wont be lag and that it will run smooth."

**Decision: the 12-hour source soak and the 48-hour installed/attended soak duration requirements are WAIVED for 0.12.0.** No elapsed-time wait is required for this release. This is a release-specific owner decision; it is not inherited by any later version.

What the waiver does NOT remove:

- the scripted machine soaks (`npm run qa:soak`, `npm run qa:soak:scale`) — run and recorded in [VALIDATION.md](VALIDATION.md);
- the post-bump `test:fast` / `test:http` gates, the claims re-lock and the website mirror check;
- the installed-exe smoke on the exact signed candidate and the installed reliability/lag measurement the owner asked for in place of the soak (see [INSTALLED_LAG_TEST.md](INSTALLED_LAG_TEST.md));
- the canonical `npm run qa:ready` receipt, the staged-draft T0 / G1 packaged proofs, and the owner's Publish click.

Carry this waiver into the public release notes' upgrade section as the reason no soak duration is cited for 0.12.0.
