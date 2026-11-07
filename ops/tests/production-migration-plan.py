#!/usr/bin/env python3
"""Exercise generated SQL only on a disposable synthetic database."""
import importlib.util
import json
import pathlib
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ops/production"))
import migration_plan as plan

spec = importlib.util.spec_from_file_location("schema_rehearsal", ROOT / "ops/tests/production-schema.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
qa.NAME = "mw-prod-plan-qa-" + uuid.uuid4().hex[:12]


def inspect():
    return json.loads(qa.sql(plan.INSPECTION_SQL))


def main():
    hashes, paths = plan.inventory()
    created = False
    checks = []
    try:
        qa.run(["docker", "run", "--pull=never", "-d", "--name", qa.NAME, "--network", "none",
                "--label", "mw.environment=isolated-qa", "--label", "mw.purpose=production-plan-rehearsal",
                "-e", "POSTGRES_HOST_AUTH_METHOD=trust", qa.IMAGE])
        created = True
        qa.wait_ready()
        qa.sql("BEGIN;\n" + qa.BOOTSTRAP + "\n".join((ROOT / p).read_text() for p in paths[:14]) +
               "\n" + qa.IDENTITY_SQL + "\n" +
               "\n".join("INSERT INTO mw_private.schema_files VALUES(" + plan.literal(p) + "," +
                         plan.literal(hashes[p]) + ");" for p in paths[:14]) + "\nCOMMIT;")
        baseline = inspect()
        before = qa.fingerprint()
        operation = plan.build_plan(baseline, "1" * 40, str(uuid.uuid4()))
        plan.validate_plan(operation)
        if plan.result_status(operation, baseline) != "baseline_unchanged":
            raise RuntimeError("BASELINE_STATUS_WRONG")
        # Each fault and the attempted migration share a transaction. The psql
        # error closes the connection and rolls all fixture mutations back.
        cases = [
            ("UPDATE mw_private.environment SET instance_id='11111111-2222-4333-8444-555555555555';",
             "PLAN_IDENTITY_CHANGED"),
            ("ALTER TABLE public.categories ADD COLUMN unexpected text;", "PLAN_SCHEMA_CHANGED"),
            ("GRANT SELECT ON public.product_costs TO anon;", "PLAN_SCHEMA_CHANGED"),
            ("UPDATE mw_private.schema_files SET sha256='wrong' WHERE path=" + plan.literal(paths[0]) + ";",
             "PLAN_LEDGER_CHANGED"),
            ("INSERT INTO public.categories(slug,name) VALUES('synthetic-only','Учебный раздел');",
             "PLAN_DATABASE_NO_LONGER_EMPTY"),
        ]
        for mutation, error in cases:
            qa.sql("BEGIN;\n" + mutation + "\n" + operation["sql"], expected_error=error)
            if inspect() != baseline or qa.fingerprint() != before:
                raise RuntimeError("REFUSAL_CHANGED_DATABASE:" + error)
            checks.append(error)
        qa.sql(operation["sql"].removesuffix("COMMIT;\n") + "\nSELECT 1/0;\nCOMMIT;",
               expected_error="division by zero")
        if inspect() != baseline or qa.fingerprint() != before:
            raise RuntimeError("FAILED_COMMIT_CHANGED_DATABASE")
        checks.append("full_transaction_failure_rolled_back")
        # Deliberately ignore the command response, then recover by read-only status.
        qa.sql(operation["sql"])
        after = inspect()
        if plan.result_status(operation, after) != "committed":
            raise RuntimeError("COMMIT_RECEIPT_NOT_RECOVERED")
        qa.check_target(hashes)
        checks.append("lost_response_recovered_by_read")
        qa.sql(operation["sql"], expected_error="PLAN_ALREADY_ATTEMPTED_READ_STATUS")
        if inspect() != after:
            raise RuntimeError("REPEATED_PLAN_CHANGED_DATABASE")
        checks.append("repeat_refused")
        qa.run(["docker", "restart", qa.NAME])
        qa.wait_ready()
        if inspect() != after or plan.result_status(operation, inspect()) != "committed":
            raise RuntimeError("RESTART_LOST_RECEIPT")
        checks.append("restart_preserved")
        qa.sql("ALTER TABLE public.categories ADD COLUMN later_drift text;")
        if plan.result_status(operation, inspect()) != "review_required":
            raise RuntimeError("LATER_SCHEMA_DRIFT_ACCEPTED")
        checks.append("later_schema_drift_requires_review")
        qa.sql("""
DO $acl$
BEGIN
 IF has_table_privilege('anon','mw_private.production_migration_receipts','SELECT')
 OR has_table_privilege('authenticated','mw_private.production_migration_receipts','SELECT')
 OR has_table_privilege('service_role','mw_private.production_migration_receipts','SELECT,INSERT,UPDATE,DELETE')
 THEN RAISE EXCEPTION 'RECEIPT_EXPOSED'; END IF;
END $acl$;
""")
        checks.append("receipt_private")
    finally:
        if created:
            qa.run(["docker", "rm", "-f", "-v", qa.NAME])
    print(json.dumps({"passed": True, "checks": checks, "temporaryResourcesRemoved": True,
                      "syntheticOnly": True, "liveDatabaseRead": False, "backupCreated": False}))


if __name__ == "__main__":
    main()
