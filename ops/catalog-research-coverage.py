#!/usr/bin/env python3
"""Read-only, reproducible comparison of research bindings and source dictionaries.

This is vocabulary coverage, not live database validation, populated SKU coverage,
or evidence that a field is safe to publish. Nothing is written by this script.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUTS = {
    "research": "research/welding-catalog-2026-11-06/MasterWeld_Attribute_Dictionary_v1.json",
    "pilot": "src/lib/technical/pilot-dictionary.json",
    "consumables": "src/lib/technical/consumable-dictionary.json",
    "accessories": "src/lib/technical/accessory-dictionary.json",
    "composition": "src/lib/technical/dictionary.ts",
}

# Reviewed structural equivalents only. These are NOT new catalog definitions.
# Keep conditional values attached to the measured fact, never infer a separate
# continuous-current rating from a percentage.
CONTEXT = {
    **{
        f"{process}_duty_{suffix}": [(f"{process}_duty_cycle_pct", context)]
        for process in ("mma", "mig", "tig", "cut")
        for suffix, context in (("current_a", "current_a"), ("temp_c", "temperature_c"))
    },
    "duty_test_temp_c": [
        (f"{process}_duty_cycle_pct", "temperature_c") for process in ("mma", "mig", "tig")
    ],
    "mask_switching_temp_c": [("mask_switching_time_ms", "temperature_c")],
    "mig_torch_duty_pct": [
        ("mig_torch_amp_co2_a", "duty_pct"), ("mig_torch_amp_m21_a", "duty_pct")
    ],
}
# Some of these research definitions describe a standalone/filterable property.
# The existing fact context stores only a measurement condition; keep that gap.
PARTIAL_CONTEXT = {
    "mig_torch_cooling": [
        ("mig_torch_amp_co2_a", "cooling"), ("mig_torch_amp_m21_a", "cooling")
    ],
}
COMMON_EXISTING = {
    "brand": "products.brand; not a new technical fact",
    "price_rub": "products.price; private cost remains separate",
    "availability": "Existing stock/order behavior; research enum is not defined",
    "model": "Human model identity workflow; not a second free-standing model field",
    "manual_url": "Private source/model review; a URL alone does not verify a passport",
    "supplier_sku": "Import SKU mapping; exact supplier/manufacturer identity still requires review",
}

def unique(items, key, name):
    result = {}
    for item in items:
        code = key(item)
        if code in result:
            raise ValueError(f"Duplicate {name}: {code}")
        result[code] = item
    return result

def build_report(root=ROOT):
    raw = {key: (root / path).read_bytes() for key, path in INPUTS.items()}
    research, pilot, extra, accessories = (json.loads(raw[key]) for key in ("research", "pilot", "consumables", "accessories"))
    documentary = unique(accessories["research_text_fields"], lambda x: (x["family"], x["attribute"]), "documentary representation")
    additional = unique(accessories["additional_fields"], lambda x: (x["family"], x["attribute"]), "additional field")
    # Fail closed if the composition changes: don't silently omit a later extension.
    composition = raw["composition"].decode()
    imports = [line.strip() for line in composition.splitlines() if line.startswith("import ")]
    if imports != [
        'import pilot from "./pilot-dictionary.json";',
        'import consumables from "./consumable-dictionary.json";',
        'import accessories from "./accessory-dictionary.json";',
    ]:
        raise ValueError("Dictionary composition changed; update coverage inputs explicitly")
    attributes = unique(pilot["attributes"] + extra["attributes"] + accessories["attributes"], lambda x: x["code"], "attribute")
    units = unique(pilot["units"] + extra["units"] + accessories["units"], lambda x: x["code"], "unit")
    families = unique(research["families"], lambda x: x["code"], "research family")
    runtime_families = unique(pilot["families"], lambda x: x["code"], "runtime family")
    bindings = unique(pilot["bindings"] + extra["bindings"] + accessories["bindings"],
                      lambda x: (x["family_code"], x["attribute_code"]), "binding")
    for (family, code), binding in bindings.items():
        if family not in runtime_families or family not in families or code not in attributes:
            raise ValueError(f"Broken binding: {family}/{code}")
        attribute = attributes[code]
        if attribute["unit_code"] not in units:
            raise ValueError(f"Unknown unit: {code}")
        if attribute["kind"] in ("enum", "enum_list"):
            options = binding["options_override"]
            if options is None:
                options = attribute["options"]
            if not options or len(set(options)) != len(options):
                raise ValueError(f"Missing/duplicate runtime options: {family}/{code}")

    totals = Counter()
    rows = []
    addressed = set()
    research_keys = set()
    def targets(family, candidates):
        result = []
        for code, context in candidates:
            if (family, code) in bindings and context in attributes[code]["required_context"]:
                result.append({"attribute": code, "context": context})
        return result

    for family, definition in families.items():
        research_attributes = unique(definition["attributes"], lambda x: x["key"], "research binding")
        entries = []
        for code, proposed in research_attributes.items():
            research_keys.add(code)
            entry = {"key": code, "type": proposed["type"], "unit": proposed["unit"],
                     "priority": proposed["priority"]}
            if (family, code) in bindings:
                attribute = attributes[code]
                entry["status"] = "direct_definition"
                entry["required_context"] = attribute["required_context"]
                entry["fixed_context"] = attribute["fixed_context"]
                entry["processes"] = attribute["processes"]
                entry["runtime_unit"] = units[attribute["unit_code"]]["label"]
                # A matching code is NOT proof of complete semantic equivalence.
                if (family, code) in documentary:
                    reviewed = documentary[(family, code)]
                    if (attribute["kind"] != "text" or proposed["type"] not in ("enum", "enum_list")
                            or proposed["type"] != reviewed["research_kind"]):
                        raise ValueError(f"Documentary representation changed: {family}/{code}")
                    entry["status"] = "documentary_definition"
                    entry["runtime_kind"] = attribute["kind"]
                    entry["note"] = reviewed["representation"]
                elif proposed["type"] != attribute["kind"]:
                    entry["status"] = "definition_needs_review"
                # Text may intentionally retain a range/conditions verbatim, with
                # unit_code=none. Expose that difference for review, don't convert.
                expected_unit = proposed["unit"] or "—"
                if expected_unit != entry["runtime_unit"]:
                    entry["unit_difference"] = True
                addressed.add((family, code))
            elif code in CONTEXT and (mapped := targets(family, CONTEXT[code])):
                entry["status"] = "measurement_context"
                entry["targets"] = mapped
                if len(mapped) != len(CONTEXT[code]):
                    entry["status"] = "partial_context"
            elif code in PARTIAL_CONTEXT and (mapped := targets(family, PARTIAL_CONTEXT[code])):
                entry["status"] = "partial_context"
                entry["targets"] = mapped
            elif code == "power_consumption_by_mode_kva" and (family, "power_consumption_kva") in bindings:
                attribute = attributes["power_consumption_kva"]
                entry["status"] = "explicit_process_values"
                entry["attribute"] = "power_consumption_kva"
                entry["processes"] = attribute["processes"]
                entry["note"] = "Research mode_map has no inner schema; equivalence remains bounded to these processes"
                addressed.add((family, "power_consumption_kva"))
            else:
                entry["status"] = (
                    "missing_family_binding" if code in attributes else
                    "missing_enum_vocabulary" if proposed["type"] in ("enum", "enum_list") else
                    "needs_schema_design"
                )
                if proposed["unit"] and proposed["unit"] not in {u["label"] for u in units.values()}:
                    entry["new_unit_needed"] = True
            totals[entry["status"]] += 1
            entries.append(entry)
        rows.append({
            "code": family, "label": definition["name"],
            "has_runtime_fields": any(f == family for f, _ in bindings),
            "counts": dict(sorted(Counter(e["status"] for e in entries).items())),
            "fields": entries,
        })

    # Every research binding and every runtime binding is accounted for; extras
    # remain visible instead of inflating the number of covered research rows.
    if not documentary.keys() <= addressed:
        raise ValueError("Documentary representation lost its research binding")
    unmatched = [{"family": f, "attribute": a,
                  **({"note": additional[(f, a)]["reason"]} if (f, a) in additional else {})}
                 for f, a in bindings if (f, a) not in addressed]
    if not additional.keys() <= set(bindings) - addressed:
        raise ValueError("Additional fields no longer match their declared scope")
    research_rows = sum(len(f["attributes"]) for f in research["families"])
    if sum(totals.values()) != research_rows:
        raise ValueError("Coverage lost a research row")
    common = [{"key": a["key"], "status": "separate_workflow_review" if a["key"] in COMMON_EXISTING else "needs_schema_design",
               "note": COMMON_EXISTING.get(a["key"], "Not defined by this technical dictionary audit")}
              for a in research["common_attributes"]]
    return {
        "schema_version": 1,
        "scope": "Source dictionary coverage only; no SKU values, live DB, UI acceptance, search facets or publication readiness",
        "inputs": {key: {"path": INPUTS[key], "sha256": hashlib.sha256(value).hexdigest()}
                   for key, value in raw.items()},
        "totals": {
            "research_families": len(families), "research_special_bindings": research_rows,
            "research_special_keys": len(research_keys), "research_common_fields": len(common),
            "runtime_attributes": len(attributes), "runtime_bindings": len(bindings),
            "families_with_runtime_fields": sum(f["has_runtime_fields"] for f in rows),
            "research_binding_statuses": dict(sorted(totals.items())),
        },
        "families": rows, "common_fields": common,
        "runtime_bindings_without_direct_research_row": unmatched,
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary", action="store_true")
    parser.add_argument("--check", type=Path, help="Verify a previously recorded report without writing")
    args = parser.parse_args()
    report = build_report()
    if args.check and json.loads(args.check.read_text()) != report:
        raise SystemExit("STALE_CATALOG_COVERAGE_REPORT")
    print(json.dumps(report["totals"] if args.summary else report, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
