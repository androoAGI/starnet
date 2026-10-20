# StarNet Phase 4 the reference harness Baseline

This is the replacement contract StarNet must satisfy before it can become the
main harness in place of the reference harness.

## the reference harness Baseline Capabilities

the reference harness is considered reliable enough today because it can repeatedly:

- Run a real paid model call with known provider, model, spend, and end reason.
- Carry a normal task loop from request to useful output without losing context.
- Produce file deliverables and make small code/doc edits with verification.
- Run shell or verification commands and surface failures as diagnoses.
- Preserve transcript, artifacts, memory/logbook, ledger, and model/spend truth
  after restart.
- Handle cancellation, budget stops, denied consent, tool errors, and recovery
  states without pretending the task completed successfully.
- Feel smooth enough that red gates, missing proof, or stuck runs are not
  normalized away.

## StarNet Cutover Bar

StarNet does not need to clone the reference harness's interface. It must prove the same
daily-driver reliability through the gamified UI and StarNet safety model.

The Phase 4 cutover loop is green only when:

- This baseline stays stable.
- StarNet completes the same-work trial through attended UI evidence.
- The paid live provider path passes.
- One fresh pass and one restart pass preserve all required provenance.
- Failure/recovery paths are proven by automated and attended evidence.
- The final go/no-go decision is recorded.

## Accepted Pilot Scope

No broad feature parity is accepted by default. Browser automation,
computer-use, desktop release packaging, and connector breadth may be accepted
for pilot scope only if the final decision record says so explicitly.
