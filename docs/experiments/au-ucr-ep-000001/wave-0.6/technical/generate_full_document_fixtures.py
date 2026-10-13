"""Generate deterministic full-document fixtures for every concrete schema."""

from __future__ import annotations

import copy
import json
import pathlib
import warnings

warnings.filterwarnings("ignore", category=DeprecationWarning)

from jsonschema import Draft202012Validator, FormatChecker, RefResolver


ROOT = pathlib.Path(__file__).resolve().parent
SCHEMA_DIR = ROOT / "schemas"
OUTPUT = SCHEMA_DIR / "fixtures" / "full-document-fixtures.json"
MATRIX = ROOT / "W06_SCHEMA_FULL_DOCUMENT_COVERAGE_MATRIX.md"
HELPERS = {"common.schema.json", "authority-object-base.schema.json"}


def merge(left, right):
    if right == {}:
        return copy.deepcopy(left)
    if isinstance(left, dict) and isinstance(right, dict):
        result = copy.deepcopy(left)
        for key, value in right.items():
            result[key] = merge(result[key], value) if key in result else copy.deepcopy(value)
        return result
    return copy.deepcopy(right)


def has_literal(schema):
    if isinstance(schema, dict):
        if "const" in schema or "enum" in schema:
            return True
        return any(has_literal(value) for value in schema.values())
    if isinstance(schema, list):
        return any(has_literal(value) for value in schema)
    return False


class Factory:
    def __init__(self, documents):
        self.documents = documents
        self.store = {}
        for name, document in documents.items():
            self.store[name] = document
            self.store[document["$id"]] = document

    def resolve(self, reference, root):
        if reference.startswith("#"):
            document = root
            resolved_root = root
            fragment = reference[1:]
        else:
            name, _, fragment = reference.partition("#")
            document = self.documents[pathlib.Path(name).name]
            resolved_root = document
        for token in fragment.lstrip("/").split("/") if fragment else []:
            token = token.replace("~1", "/").replace("~0", "~")
            document = document[int(token)] if isinstance(document, list) else document[token]
        return document, resolved_root

    def string(self, schema, seed):
        if schema.get("format") == "date-time" or "T\\d{2}" in schema.get("pattern", ""):
            return f"2026-10-12T{seed % 20:02d}:00:00Z"
        pattern = schema.get("pattern", "")
        if "urn:uuid:" in pattern:
            return f"urn:uuid:{seed:08x}-1111-4111-8111-{seed:012x}"
        if "{64}" in pattern:
            return f"{seed % 16:x}" * 64
        if "{40}" in pattern:
            return f"{seed % 16:x}" * 40
        if "{85}" in pattern:
            return "A" * 85 + "A"
        if pattern.count("[0-9]+") == 3 and "\\." in pattern:
            return "1.0.0"
        if "(?:\\\\.[a-z0-9-]+)+" in pattern:
            return f"example.field-{seed}"
        minimum = schema.get("minLength", 1)
        candidate = f"urn:example:fixture:{seed}"
        if schema.get("maxLength") is not None:
            candidate = candidate[: schema["maxLength"]]
        if len(candidate) < minimum:
            candidate += "x" * (minimum - len(candidate))
        return candidate

    def make(self, schema, root, seed=1):
        if "$ref" in schema:
            resolved, resolved_root = self.resolve(schema["$ref"], root)
            return self.make(resolved, resolved_root, seed)
        if "const" in schema:
            return copy.deepcopy(schema["const"])
        if "enum" in schema:
            return copy.deepcopy(schema["enum"][seed % len(schema["enum"])])

        if "allOf" in schema:
            value = self.make({k: v for k, v in schema.items() if k != "allOf"}, root, seed)
            for index, branch in enumerate(schema["allOf"]):
                value = merge(value, self.make(branch, root, seed + index + 1))
                value = self.refine(value, branch, root, seed + index + 1)
            for index, branch in enumerate(schema["allOf"]):
                condition = branch.get("if") if isinstance(branch, dict) else None
                if condition and not list(self.validator(condition, root).iter_errors(value)):
                    then_schema = branch.get("then", {})
                    value = merge(value, self.make(then_schema, root, seed + index + 20))
                    value = self.refine(value, then_schema, root, seed + index + 20)
                if (
                    isinstance(value, list)
                    and isinstance(branch, dict)
                    and "contains" in branch
                ):
                    base_item = copy.deepcopy(value[0]) if value else {}
                    constrained = merge(
                        base_item,
                        self.make(branch["contains"], root, seed + index + 30),
                    )
                    constrained = self.refine(
                        constrained, branch["contains"], root, seed + index + 30
                    )
                    if value:
                        value[index % len(value)] = constrained
                    else:
                        value.append(constrained)
            return value
        if "oneOf" in schema:
            base = self.make({k: v for k, v in schema.items() if k != "oneOf"}, root, seed)
            return merge(base, self.make(schema["oneOf"][0], root, seed + 1))
        if "anyOf" in schema:
            base = self.make({k: v for k, v in schema.items() if k != "anyOf"}, root, seed)
            return merge(base, self.make(schema["anyOf"][0], root, seed + 1))

        kind = schema.get("type")
        if kind == "object" or "properties" in schema or "required" in schema:
            result = {}
            required = set(schema.get("required", []))
            for name, subschema in schema.get("properties", {}).items():
                if name in required or has_literal(subschema):
                    result[name] = self.make(subschema, root, seed + len(result) + 1)
            for conditional in schema.get("allOf", []):
                condition = conditional.get("if")
                if condition and not list(self.validator(condition, root).iter_errors(result)):
                    result = merge(result, self.make(conditional.get("then", {}), root, seed + 20))
            return result
        if kind == "array":
            count = schema.get("minItems", 0)
            return [self.make(schema.get("items", {}), root, seed + index + 1) for index in range(count)]
        if kind == "integer":
            return schema.get("minimum", 0) + seed % 3
        if kind == "number":
            return schema.get("minimum", 0)
        if kind == "boolean":
            return True
        if kind == "null":
            return None
        if kind == "string" or "pattern" in schema or "format" in schema:
            return self.string(schema, seed)
        return {}

    def refine(self, value, schema, root, seed):
        if "$ref" in schema:
            resolved, resolved_root = self.resolve(schema["$ref"], root)
            return self.refine(value, resolved, resolved_root, seed)
        if "const" in schema or "enum" in schema:
            return self.make(schema, root, seed)
        if "allOf" in schema:
            for index, branch in enumerate(schema["allOf"]):
                value = self.refine(value, branch, root, seed + index + 1)
        if isinstance(value, dict):
            required = set(schema.get("required", []))
            for name, subschema in schema.get("properties", {}).items():
                if name in value:
                    value[name] = self.refine(value[name], subschema, root, seed + 1)
                elif name in required or has_literal(subschema):
                    value[name] = self.make(subschema, root, seed + 1)
        elif any(key in schema for key in ("pattern", "format", "minimum", "maximum")):
            if list(self.validator(schema, root).iter_errors(value)):
                value = self.make(schema, root, seed)
        return value

    def validator(self, schema, root):
        return Draft202012Validator(
            schema,
            resolver=RefResolver.from_schema(root, store=self.store),
            format_checker=FormatChecker(),
        )


def first_required_negative(instance, schema):
    for name in schema.get("required", []):
        if name in instance:
            negative = copy.deepcopy(instance)
            del negative[name]
            return negative, f"required property {name}"
    raise ValueError("no removable required property")


def first_scalar_path(value, path=()):
    if isinstance(value, dict):
        for key, child in value.items():
            found = first_scalar_path(child, path + (key,))
            if found:
                return found
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found = first_scalar_path(child, path + (index,))
            if found:
                return found
    else:
        return path
    return None


def set_path(document, path, value):
    current = document
    for token in path[:-1]:
        current = current[token]
    current[path[-1]] = value


def targeted_negative(instance, validator):
    for path in scalar_paths(instance):
        original = value_at(instance, path)
        candidates = [None, "__invalid__", -1, not original if isinstance(original, bool) else False]
        for replacement in candidates:
            if replacement == original:
                continue
            negative = copy.deepcopy(instance)
            set_path(negative, path, replacement)
            errors = list(validator.iter_errors(negative))
            if errors:
                return negative, "/".join(map(str, path)), errors[0].validator
    raise ValueError("unable to derive targeted negative")


def composition_literal_paths(factory, schema, root, path=(), inside=False):
    if "$ref" in schema:
        resolved, resolved_root = factory.resolve(schema["$ref"], root)
        yield from composition_literal_paths(
            factory, resolved, resolved_root, path, inside
        )
        return
    if inside and ("const" in schema or "enum" in schema):
        yield path
    for keyword in ("allOf", "oneOf", "anyOf"):
        for branch in schema.get(keyword, []):
            yield from composition_literal_paths(factory, branch, root, path, True)
    for name, subschema in schema.get("properties", {}).items():
        yield from composition_literal_paths(
            factory, subschema, root, path + (name,), inside
        )


def composition_negative(factory, instance, schema, validator):
    for path in composition_literal_paths(factory, schema, schema):
        try:
            original = value_at(instance, path)
        except (KeyError, IndexError, TypeError):
            continue
        for replacement in ("__composition_invalid__", None, -1):
            if replacement == original:
                continue
            negative = copy.deepcopy(instance)
            set_path(negative, path, replacement)
            errors = list(validator.iter_errors(negative))
            if errors:
                return negative, "/".join(map(str, path)), errors[0].validator
    return None


def apply_required(factory, instance, constraint, parent_schema, root, seed):
    result = copy.deepcopy(instance)
    if "anyOf" in constraint:
        return apply_required(
            factory, result, constraint["anyOf"][0], parent_schema, root, seed
        )
    for name, subschema in constraint.get("properties", {}).items():
        result[name] = factory.make(subschema, root, seed + 1)
    for name in constraint.get("required", []):
        if name not in result:
            result[name] = factory.make(parent_schema["properties"][name], root, seed + 2)
    return result


def conditional_cases(factory, name, schema, positive, validator, prefix):
    conditionals = [
        branch
        for branch in schema.get("allOf", [])
        if isinstance(branch, dict) and "if" in branch and "then" in branch
    ]
    if not conditionals:
        return []
    branch = conditionals[0]
    triggered = apply_required(factory, positive, branch["if"], schema, schema, 9000)
    for required_name in branch["then"].get("required", []):
        if required_name not in triggered:
            triggered[required_name] = factory.make(
                schema["properties"][required_name], schema, 9100
            )
    triggered = factory.refine(triggered, branch["then"], schema, 9200)

    if name == "reinstatement-receipt.schema.json":
        issuers = triggered["issuers"]
        if not any(item.get("role") == "DECISION_CHAIR" for item in issuers):
            chair = copy.deepcopy(issuers[0])
            chair["role"] = "DECISION_CHAIR"
            issuers.append(chair)

    assert not list(validator.iter_errors(triggered)), f"{name} conditional positive"
    negative = copy.deepcopy(triggered)
    if name == "attestation-evidence.schema.json":
        del negative["prior_evidence_digest"]
        defect = "LIVENESS omitted then-required prior_evidence_digest"
    elif name == "governed-audit-ledger-envelope.schema.json":
        negative["prev_hash"] = "f" * 64
        defect = "genesis sequence retained nonzero predecessor"
    elif name == "reinstatement-receipt.schema.json":
        for issuer in negative["issuers"]:
            if issuer.get("role") == "DECISION_CHAIR":
                issuer["role"] = "UNAUTHORIZED_ROLE"
                break
        defect = "A09-triggered reinstatement omitted Decision Chair issuer"
    else:
        raise AssertionError(name)
    assert list(validator.iter_errors(negative)), f"{name} conditional negative"
    return [
        {
            "id": f"{prefix}-POS-CONDITIONAL",
            "schema": f"../{name}",
            "expect": "VALID",
            "requirement": "F-PRELIM-02:CONDITIONAL-THEN-POSITIVE",
            "instance": triggered,
        },
        {
            "id": f"{prefix}-NEG-CONDITIONAL",
            "schema": f"../{name}",
            "expect": "INVALID",
            "requirement": "F-PRELIM-02:CONDITIONAL-THEN-NEGATIVE",
            "single_target_defect": defect,
            "instance": negative,
        },
    ]


def scalar_paths(value, path=()):
    if isinstance(value, dict):
        for key, child in value.items():
            yield from scalar_paths(child, path + (key,))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from scalar_paths(child, path + (index,))
    else:
        yield path


def value_at(document, path):
    current = document
    for token in path:
        current = current[token]
    return current


def keyword_inventory(value, found=None):
    found = found or set()
    if isinstance(value, dict):
        for keyword in ("allOf", "anyOf", "oneOf", "if", "then", "else", "additionalProperties", "unevaluatedProperties"):
            if keyword in value:
                found.add(keyword)
        for child in value.values():
            keyword_inventory(child, found)
    elif isinstance(value, list):
        for child in value:
            keyword_inventory(child, found)
    return sorted(found)


def main():
    documents = {
        path.name: json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(SCHEMA_DIR.glob("*.schema.json"))
    }
    factory = Factory(documents)
    cases = []
    coverage = []

    for index, (name, schema) in enumerate(documents.items(), 1):
        if name in HELPERS:
            continue
        schema_validator = factory.validator(schema, schema)
        positive = factory.make(schema, schema, index * 100)
        errors = list(schema_validator.iter_errors(positive))
        if errors:
            messages = [" -> ".join(map(str, error.absolute_path)) + ": " + error.message for error in errors[:5]]
            raise AssertionError(f"{name} synthesis failed: {messages}")

        prefix = f"FULL-{index:02d}"
        cases.append(
            {
                "id": f"{prefix}-POS",
                "schema": f"../{name}",
                "expect": "VALID",
                "requirement": "F-PRELIM-02:COMPLETE-OBJECT-POSITIVE",
                "instance": positive,
            }
        )

        missing, detail = first_required_negative(positive, schema)
        cases.append(
            {
                "id": f"{prefix}-NEG-REQUIRED",
                "schema": f"../{name}",
                "expect": "INVALID",
                "requirement": "F-PRELIM-02:REQUIRED-BOUNDARY",
                "single_target_defect": detail,
                "instance": missing,
            }
        )

        additional = copy.deepcopy(positive)
        additional["unexpected_wave_0_6_property"] = True
        if list(schema_validator.iter_errors(additional)):
            cases.append(
                {
                    "id": f"{prefix}-NEG-ADDITIONAL",
                    "schema": f"../{name}",
                    "expect": "INVALID",
                    "requirement": "F-PRELIM-02:ADDITIONAL-OR-UNEVALUATED-PROPERTY-BOUNDARY",
                    "single_target_defect": "one undeclared root property",
                    "instance": additional,
                }
            )

        targeted, path, validator_keyword = targeted_negative(positive, schema_validator)
        cases.append(
            {
                "id": f"{prefix}-NEG-TARGETED",
                "schema": f"../{name}",
                "expect": "INVALID",
                "requirement": "F-PRELIM-02:COMPOSITION-OR-CONSTRAINT-BOUNDARY",
                "single_target_defect": f"mutated {path}; detected by {validator_keyword}",
                "instance": targeted,
            }
        )

        composition = composition_negative(factory, positive, schema, schema_validator)
        if composition:
            composed, path, validator_keyword = composition
            cases.append(
                {
                    "id": f"{prefix}-NEG-COMPOSITION",
                    "schema": f"../{name}",
                    "expect": "INVALID",
                    "requirement": "F-PRELIM-02:ALLOF-ONEOF-ANYOF-BOUNDARY",
                    "single_target_defect": (
                        f"mutated composition-bound {path}; detected by {validator_keyword}"
                    ),
                    "instance": composed,
                }
            )

        cases.extend(
            conditional_cases(
                factory, name, schema, positive, schema_validator, prefix
            )
        )
        coverage.append(
            {
                "schema": name,
                "schema_id": schema["$id"],
                "classification": "CONCRETE_INSTANTIABLE",
                "keywords": keyword_inventory(schema),
                "case_ids": [case["id"] for case in cases if case["id"].startswith(prefix)],
            }
        )

    document = {
        "status": "FINAL_TECHNICAL_FIXTURES_NOT_ADOPTED",
        "finding": "F-PRELIM-02",
        "concrete_schema_count": len(documents) - len(HELPERS),
        "abstract_helper_schema_count": len(HELPERS),
        "case_count": len(cases),
        "cases": cases,
        "coverage": coverage,
    }
    OUTPUT.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8", newline="\n")
    positive_count = sum(case["expect"] == "VALID" for case in cases)
    negative_count = sum(case["expect"] == "INVALID" for case in cases)
    lines = [
        "# Wave 0.6 Schema Full-Document Coverage Matrix",
        "",
        "## Classification and totals",
        "",
        f"- Concrete/instantiable schemas: **{document['concrete_schema_count']}**",
        f"- Definition-only abstract/helper schemas: **{document['abstract_helper_schema_count']}**",
        f"- Generated full-document cases: **{len(cases)}** "
        f"({positive_count} valid, {negative_count} invalid)",
        "- Existing governed-event full-document cases retained: **2** (one valid, one invalid)",
        f"- Checker total: **{len(cases) + 2}** full-document cases",
        "",
        "A concrete schema has a top-level instance contract. `profile-receipt` is concrete and",
        "instantiable, but its required `abstract_only: true` marker makes it non-authorizing.",
        "`common.schema.json` and `authority-object-base.schema.json` contain only reusable `$defs`;",
        "they have no meaningful standalone instance contract and are exercised through concrete",
        "schemas that reference those definitions.",
        "",
        "## Matrix",
        "",
        "| Schema | Classification | Full-document cases | Boundary keywords |",
        "| --- | --- | ---: | --- |",
    ]
    for item in coverage:
        lines.append(
            f"| `{item['schema']}` | Concrete/instantiable | {len(item['case_ids'])} | "
            f"{', '.join(f'`{word}`' for word in item['keywords']) or 'direct constraints'} |"
        )
    for helper in sorted(HELPERS):
        token = helper
        dependents = [
            name
            for name, schema in documents.items()
            if name not in HELPERS and token in json.dumps(schema)
        ]
        lines.append(
            f"| `{helper}` | Definition-only helper | 0 standalone; exercised by "
            f"{len(dependents)} concrete dependents | `$defs`, `$ref` |"
        )
    lines.extend(
        [
            "",
            "## Boundary interpretation",
            "",
            "Every concrete schema has a complete valid document, a missing-required negative, an",
            "undeclared-root-property negative, and a targeted constraint negative. Schemas with",
            "`allOf`, `oneOf`, or `anyOf` also have a composition-bound negative where a concrete",
            "composition literal is reachable. The three schemas with `if`/`then` each have a valid",
            "triggered document and a targeted invalid document that violates the active `then`",
            "branch.",
            "",
            "These cases establish JSON Schema behavior only. They do not establish cross-object",
            "identity, digest correctness, time ordering, state transitions, replay handling,",
            "signature validity, authority, adoption, or operational enforcement.",
            "",
        ]
    )
    MATRIX.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(f"concrete_schemas={document['concrete_schema_count']}")
    print(f"abstract_helpers={document['abstract_helper_schema_count']}")
    print(f"full_document_cases={document['case_count']}")
    print(f"output={OUTPUT.name}")
    print(f"matrix={MATRIX.name}")


if __name__ == "__main__":
    main()
