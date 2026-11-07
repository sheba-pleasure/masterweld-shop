"""Shared read-only accessory dictionary probe for DEV and production guards."""
import hashlib
import json
import pathlib

CAPABILITY = "mw.capabilities.accessory-dictionary"
DICTIONARY_SHA256 = "0cca3eab034ee7c22e52c4ea9282dafed43b3e2a8a15d4777468dd1c381c2718"


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def probe_sql():
    data = (pathlib.Path(__file__).resolve().parents[1] / "src/lib/technical/accessory-dictionary.json").read_bytes()
    if hashlib.sha256(data).hexdigest() != DICTIONARY_SHA256:
        raise RuntimeError("ACCESSORY_GUARD_DICTIONARY_CHECKSUM")
    dictionary = json.loads(data)
    # Only inspected rows belong to this extension. Other established families remain valid.
    specs = [
        ("technical_units", dictionary["units"], "code", [r["code"] for r in dictionary["units"]]),
        ("technical_attributes", dictionary["attributes"], "code", [r["code"] for r in dictionary["attributes"]]),
        ("technical_family_attributes", dictionary["bindings"], "family_code",
         sorted({r["family_code"] for r in dictionary["bindings"]})),
    ]
    queries = ""
    for table, expected, key, keys in specs:
        predicate = key + " IN (" + ",".join(map(literal, keys)) + ")"
        if table == "technical_family_attributes":
            predicate += " OR attribute_code IN (" + ",".join(literal(r["code"]) for r in dictionary["attributes"]) + ")"
        query = "SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM public." + table + " t WHERE " + predicate
        queries += """
 IF to_regclass('public.""" + table + """') IS NULL THEN
  rows_match := false;
 ELSE
  EXECUTE """ + literal(query) + """ INTO actual;
  SELECT jsonb_agg(value ORDER BY value::text) INTO expected
   FROM jsonb_array_elements(""" + literal(json.dumps(expected)) + """::jsonb);
  has_rows := has_rows OR jsonb_array_length(actual)>0;
  rows_match := rows_match AND actual IS NOT DISTINCT FROM expected;
 END IF;
"""
    # SET LOCAL of a private session setting does not persist data or install functions.
    # Dynamic SELECT permits inspecting pre-dictionary schemas without naming absent tables.
    return """
DO $accessory_probe$
DECLARE actual jsonb; expected jsonb; has_rows boolean:=false; rows_match boolean:=true;
BEGIN
""" + queries + """
 PERFORM set_config('mw.accessory_schema',jsonb_build_array(
  to_regprocedure('mw_private.accessory_dictionary_version()') IS NOT NULL,
  EXISTS(SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
   WHERE p.oid=to_regprocedure('mw_private.accessory_dictionary_version()')
    AND p.prorettype='integer'::regtype AND p.provolatile='i' AND l.lanname='sql' AND p.prosrc='SELECT 1'),
  has_rows, rows_match)::text,true);
END $accessory_probe$;
"""
