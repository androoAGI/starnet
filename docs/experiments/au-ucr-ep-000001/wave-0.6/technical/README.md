# Wave 0.6 Final Technical Specification

## Control

- Project: `AU-UCR-EP-000001`
- Human Principal and sole final decision authority: **Hakeem Moore**
- Technical owner: Wave 0.6 Agent A
- Registry: `urn:au-ucr:registry:wave-0.5-contract:1.3.0`
- Status: `FINAL_TECHNICAL_SPECIFICATION_NOT_ADOPTED`
- Operational, publication, acceptance, and execution effect: `NONE`

This directory is the append-only Wave 0.6 technical completion package. Waves 0.3 through 0.5
remain historical inputs and are not modified by this package.

## Normative precedence

1. `W06_TECHNICAL_FREEZE_MANIFEST.json` fixes exact normative bytes.
2. `W05_VERSIONED_REGISTRY.md` controls identifiers, profiles, vocabularies, framing, purpose
   separation, reason ordering, and safe states.
3. `W05_SHARED_TRUST_AND_STATE_CONTRACT.md` controls trust, ownership, state, and authority
   semantics.
4. `W05_INTERFACE_MATRIX.md` controls `IF-01` through `IF-22`.
5. `schemas/*.schema.json` controls machine-checkable object shape.
6. `W06_CANONICAL_VECTOR_SPEC.md` and the frozen vector bundle control canonical examples and
   expected technical outcomes.

Unknown or conflicting values fail closed. A schema-valid object is not thereby authorized,
signed, adopted, accepted, published, or operational.

## Contents

- 35 Draft 2020-12 schemas with 35 unique canonical IDs: 33 concrete/instantiable and two
  definition-only helpers;
- 160 requirement-traced generated full-document cases plus two retained governed-event cases,
  and 57 positive/negative subschema pairs;
- one canonical Registry 1.3.0 vector family with 14 scenarios;
- deterministic vector generator and separate-code-path reproducer;
- final Registry 1.3.0 contract, shared trust/state contract, and 22-interface matrix;
- a local structural checker and exact-byte freeze manifest; and
- the technical completion report.

No retired pre-correction fixture is normative in this package.

`W06_SCHEMA_FULL_DOCUMENT_COVERAGE_MATRIX.md` classifies every schema and maps complete valid,
required-field, undeclared-property, targeted-constraint, composition, and conditional cases.
These checks establish JSON Schema behavior only, not cross-object or operational semantics.
