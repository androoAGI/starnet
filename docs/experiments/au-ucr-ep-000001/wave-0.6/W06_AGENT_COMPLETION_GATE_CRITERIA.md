# Wave 0.6 Agent Completion Gate Criteria

## Gate purpose

This gate separates agent completion from Hakeem Moore's final human decision. Passing this gate
means the submission is decision-ready; it does not mean the proposal is accepted or authorized.

## Required evidence

| Criterion | Required evidence | Pass rule |
| --- | --- | --- |
| `ACG-01` | Technical freeze record covering schemas, vectors, registry and interfaces | Every normative technical object is identified and internally reconciled |
| `ACG-02` | Permitted verification report and reproducible results | Every permitted check is executed; failures are resolved or explicitly residual |
| `ACG-03` | Governance model and decision templates | Roles, boundaries, lifecycle and exact requested scope are complete without a fabricated human act |
| `ACG-04` | Evidence inventory and lineage ledger | Every relied-on claim has a resolvable source or an explicit evidence limitation |
| `ACG-05` | Scrum closure report | No task with an agent owner remains `OPEN`, `PENDING` or `BLOCKED` |
| `ACG-06` | Cross-workstream dependency matrix | Every agent-to-agent dependency is closed |
| `ACG-07` | Final independent technical assurance | Integrated package is challenged after all workstream outputs exist |
| `ACG-08` | Residual risk and restricted-test register | Every unexecuted activity is named, justified and excluded from verified claims |
| `ACG-09` | Consolidated final decision dossier | Internal references, state labels and decision options are consistent |
| `ACG-10` | Approval-integrity check | No agent-authored `APPROVE`, signature or acknowledgement is attributed to Hakeem Moore |

## Status vocabulary

- `COMPLETED`: the agent-owned artifact exists and contains no unfinished agent work.
- `VERIFIED`: the stated check was actually executed with recorded evidence.
- `LIMITED`: the preparatory artifact is complete but the underlying activity is prohibited or
  unavailable and is not claimed as verified.
- `HUMAN_DECISION_DEPENDENCY`: all agent preparation is complete and only Hakeem Moore's explicit
  decision remains.
- `ACCEPTED`: reserved for an explicit decision by Hakeem Moore; agents cannot assign it.

## Gate decision rule

The Agent Completion Gate passes only if `ACG-01` through `ACG-10` pass. Any agent-remediable
failure returns to the responsible workstream. A prohibited operational activity does not fail
the gate when its plan, controls, acceptance criteria, evidence requirements and limitation are
complete and the activity is not represented as executed.
