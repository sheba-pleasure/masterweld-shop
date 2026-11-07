"""Accessory proposal checks, called only with an isolated test SQL adapter."""
import copy
import hashlib
import json


def check_accessories(sql, root):
    def lit(value):
        return "'" + str(value).replace("'", "''") + "'"
    extension = json.loads((root / "src/lib/technical/accessory-dictionary.json").read_text())
    proposal = (root / "docs/proposals/0043_accessory_characteristics.sql").read_text()
    tables = {"units": "technical_units", "attributes": "technical_attributes",
              "bindings": "technical_family_attributes"}
    before = {key: json.loads(sql("SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM " + table + " t"))
              for key, table in tables.items()}
    other_tables = sql("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN "
                       "('technical_units','technical_attributes','technical_family_attributes') ORDER BY tablename").splitlines()
    def snapshot():
        return {table: sql("SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')::text) FROM public."
                           + table + " t") for table in other_tables}
    baseline = snapshot()
    acl_query = """SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl) ORDER BY p.oid)
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('public','mw_private')"""
    acl_before = sql(acl_query)
    sql("BEGIN;" + proposal + "COMMIT;")
    assert snapshot() == baseline, "ACCESSORY_SEED_CHANGED_EXISTING_DATA"
    for key, table in tables.items():
        actual = json.loads(sql("SELECT jsonb_agg(to_jsonb(t)) FROM " + table + " t"))
        expected = before[key] + extension[key]
        assert sorted(actual, key=lambda x: json.dumps(x, sort_keys=True)) == sorted(expected, key=lambda x: json.dumps(x, sort_keys=True)), table
    acl_after = sql(acl_query + " AND p.oid<>'mw_private.accessory_dictionary_version()'::regprocedure")
    assert acl_before == acl_after, "ACCESSORY_SEED_CHANGED_FUNCTION_PRIVILEGES"
    for role in ("anon", "authenticated", "service_role"):
        assert sql("SELECT has_function_privilege(" + lit(role) + ",'mw_private.accessory_dictionary_version()','EXECUTE')") == "f"
        for table in tables.values():
            sql("SET ROLE " + role + "; SELECT * FROM " + table, error="permission denied")
    sql("BEGIN;" + proposal + "COMMIT;", error="duplicate key")
    source = {"key": "manual", "kind": "synthetic", "publisher": "Учебный изготовитель",
              "model": "Учебное изделие", "title": "[Учебный] Поля принадлежностей",
              "url": "https://example.invalid/accessories", "locator": "Учебная таблица",
              "checked_on": "2026-11-06", "sha256": ""}
    def validate(document, error=None):
        return sql("SELECT validate_technical_document(" + lit(json.dumps(document)) + ",'verified')", error=error)
    documents = {}
    definitions = {a["code"]: a for a in extension["attributes"]}
    for binding in extension["bindings"]:
        a = definitions[binding["attribute_code"]]
        document = documents.setdefault(binding["family_code"], {"family_code": binding["family_code"], "sources": [source], "values": []})
        value = 12.5 if a["kind"] == "number" else [1.6, 2.4] if a["kind"] == "number_list" else "Учебное обозначение / Исполнение Z"
        context = {key: {"duty_pct": 60, "current_a": 160, "test_conditions": "Учебные условия, без пересчёта единиц"}[key]
                   for key in a["required_context"]}
        fact = {"attribute_code": a["code"], "process": a["processes"][0], "unit_code": a["unit_code"],
                "state": "known", "value": value, "context": context, "source_key": "manual"}
        document["values"].append(fact)
        validate({**document, "values": [fact]})
        for key in a["required_context"]:
            missing = copy.deepcopy(fact); del missing["context"][key]
            validate({**document, "values": [missing]}, "TECH_CONTEXT_REQUIRED")
        if a["kind"] == "number":
            validate({**document, "values": [{**fact, "value": -1}]}, "TECH_BAD_RANGE")
        validate({**document, "values": [{**fact, "state": "unknown", "value": None, "context": {}, "source_key": None}]})
    for document in documents.values():
        validate(document)
    current = copy.deepcopy(documents["tig_torch"])
    current["values"] = [next(v for v in current["values"] if v["attribute_code"] == "tig_torch_max_dc_a")]
    validate({**current, "values": [current["values"][0], current["values"][0]]}, "TECH_BAD_VALUE")
    other = copy.deepcopy(current["values"][0]); other["context"]["test_conditions"] = "Другой учебный режим"
    validate({**current, "values": [current["values"][0], other]})
    holder = copy.deepcopy(documents["mma_holder"])
    for fact in holder["values"]:
        if fact["attribute_code"] == "holder_electrode_diameter_min_mm": fact["value"] = 4
        if fact["attribute_code"] == "holder_electrode_diameter_max_mm": fact["value"] = 2
    validate(holder, "TECH_REVERSED_RANGE")
    cooling = copy.deepcopy(documents["water_cooler"])
    cooling["values"] = [next(v for v in cooling["values"] if v["attribute_code"] == "cooler_capacity_w")]
    cooling["values"][0]["unit_code"] = "kw"
    validate(cooling, "TECH_BAD_VALUE")
    return {"proposal_sha256": hashlib.sha256(proposal.encode()).hexdigest(),
            "definitions": len(extension["attributes"]), "families": len(documents),
            "checks": ["exact_dictionary_extension", "old_rows_and_acl_preserved", "private_dictionary",
                       "all_fields_validated", "required_conditions", "negative_values", "unknown",
                       "duplicate_conditions", "min_max_order", "source_units"]}
