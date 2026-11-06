#!/usr/bin/env python3
"""Rehearse repo schema 0000-0002 -> 0014 on a temporary DB. NOT a Cloud restore."""
import pathlib,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[2]
DB="masterweld_dev_schema_rehearsal"
def run(args,**kw):
    result=subprocess.run(args,**kw)
    if result.returncode: raise RuntimeError(result.stderr or "REHEARSAL_FAILED")
    return result
def sql(text):
    return run(["docker","exec","-i","mw-dev-db","psql","-U","postgres","-d",DB,"-X","-v","ON_ERROR_STOP=1","-q"],input=text,text=True,capture_output=True)
# createdb fails if the name exists: never destroy someone else's prior database.
run(["docker","exec","mw-dev-db","createdb","-U","postgres",DB],capture_output=True)
try:
    files=[p for p in sorted((ROOT/"drizzle/migrations").glob("*.sql")) if p.name[:4] in ("0000","0001","0002")]
    # Roles already exist at cluster level. Only this new database schema is configured.
    sql("REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;")
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in files)+"\nCOMMIT;")
    sql("""INSERT INTO public.shop_orders(id,name,phone,items,total)
VALUES('10000000-0000-4000-8000-000000009999','DEV SCHEMA SENTINEL','+79990000000','[{"title":"fixture","qty":1,"price":900}]',900);""")
    migrations=[p for p in sorted((ROOT/"drizzle/migrations").glob("*.sql")) if p.name[:4] in ("0003","0004")]+sorted((ROOT/"docs/migrations").glob("*.sql"))
    sql("BEGIN;\n"+"\n".join(p.read_text() for p in migrations)+"\nCOMMIT;")
    sql("""DO $$ BEGIN
IF (SELECT count(*) FROM shop_orders)<>1 OR (SELECT total FROM shop_orders LIMIT 1)<>900
THEN RAISE EXCEPTION 'OLD_DATA_CHANGED'; END IF;
IF (SELECT count(*) FROM order_notifications)<>0 OR (SELECT count(*) FROM order_submissions)<>0
THEN RAISE EXCEPTION 'UNEXPECTED_BACKFILL'; END IF;
IF has_table_privilege('anon','shop_orders','INSERT') OR has_table_privilege('service_role','shop_orders','INSERT')
THEN RAISE EXCEPTION 'DIRECT_INSERT_OPEN'; END IF;
END $$;""")
    print("Repo baseline 0000-0002 -> 0014 passed; sentinel preserved; no backfill; direct INSERT closed. This is NOT a Cloud backup/restore.")
finally:
    run(["docker","exec","mw-dev-db","dropdb","-U","postgres",DB],capture_output=True)
