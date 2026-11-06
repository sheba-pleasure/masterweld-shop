#!/usr/bin/env python3
"""P0 technical catalog: disposable PostgreSQL, synthetic data, no network or real databases."""
import concurrent.futures
import copy
import datetime
import json
import importlib.util
import pathlib
import subprocess
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
NAME = "mw-tech-qa-" + uuid.uuid4().hex[:12]
PRODUCT = "10000000-0000-4000-8000-000000000001"
HIDDEN = "10000000-0000-4000-8000-000000000002"
OTHER = "10000000-0000-4000-8000-000000000003"
EDITOR = "10000000-0000-4000-8000-000000000004"

def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kwargs)

def sql(query, error=None, db="postgres"):
    r = subprocess.run(["docker", "exec", "-i", NAME, "psql", "-U", "postgres", "-d", db, "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"],
                       input=query, text=True, capture_output=True)
    if error:
        assert r.returncode and error in r.stderr, r.stderr
    elif r.returncode:
        raise RuntimeError(r.stderr)
    return r.stdout.strip().splitlines()[-1] if r.stdout.strip() else ""

def lit(value):
    if value is None: return "NULL"
    if isinstance(value, int): return str(value)
    return "'" + str(value).replace("'", "''") + "'"

def rpc(op, document=None, review="pending_review", change=None, actor=101, product=PRODUCT, error=None, expected_version="current"):
    if expected_version == "current":
        expected_version = int(sql("SELECT coalesce((SELECT version FROM technical_cards WHERE product_id="+lit(product)+"),0)")) if op == "preview" else None
    args = [actor, op, product, change, json.dumps(document) if document is not None else None, review, expected_version]
    value = sql("SET ROLE service_role; SELECT bot_technical_catalog(" + ",".join(map(lit, args)) + ");", error)
    return json.loads(value) if not error else None

def value(code, data, process="general", unit="none", context=None, state="known"):
    return {"attribute_code": code, "process": process, "state": state, "value": data, "unit_code": unit,
            "context": context or {}, "source_key": "manual" if state == "known" else None}

def document(family, values):
    return {"family_code": family, "sources": [{
        "key": "manual", "kind": "synthetic", "publisher": "Учебный изготовитель", "model": "DEV fixture",
        "title": "[Учебный] Вымышленные значения, не паспорт", "url": "https://example.invalid/manual",
        "locator": "Учебный раздел 1", "checked_on": datetime.date.today().isoformat(), "sha256": ""
    }], "values": values}

DOC = document("power_multiprocess", [
    value("mig_current_max_a", 200, "mig", "a"),
    value("mma_current_max_a", 160, "mma", "a"),
    value("mig_duty_cycle_pct", 60, "mig", "pct", {"current_a": 200, "temperature_c": 40}),
    value("mig_wire_diameters_mm", [0.8, 1.0], "mig", "mm"),
    value("tig_current_max_a", None, "tig", "a", state="unknown"),
    value("power_consumption_kva", 6.5, "mig", "kva"),
    value("power_consumption_kva", 5.2, "mma", "kva"),
])

def public(product=PRODUCT):
    result = sql("SET ROLE anon; SELECT public_product_technical(" + lit(product) + ");")
    return json.loads(result) if result else None

def preview_apply(doc=DOC, review="verified", actor=101, product=PRODUCT):
    b = rpc("preview", doc, review, actor=actor, product=product)
    rpc("apply", change=b["change_id"], actor=actor)
    return b

created = False
try:
    run(["docker", "run", "-d", "--name", NAME, "--network", "none", "--label", "mw.environment=isolated-qa",
         "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "postgres:17.6-alpine"])
    created = True
    for _ in range(120):
        if subprocess.run(["docker", "exec", NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"], capture_output=True).returncode == 0:
            break
        time.sleep(.25)
    else: raise RuntimeError("PG_NOT_READY")
    paths = [ROOT / "ops/dev/bootstrap.sql", *sorted((ROOT / "drizzle/migrations").glob("*.sql")),
             *[p for p in sorted((ROOT / "docs/migrations").glob("*.sql")) if p.name[:4]<"0017"]]
    sql("BEGIN;\n" + "\n".join(p.read_text() for p in paths) + "\nCOMMIT;")
    sql("""CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}'::jsonb $f$;
    INSERT INTO staff(telegram_id,name,role,elevated,active) VALUES
      (101,'QA admin','admin',false,true),(102,'QA other admin','admin',false,true),
      (103,'QA seller','seller',false,true),(104,'QA inactive','admin',false,false),
      (105,'QA director','director',false,true),(106,'QA elevated','director',true,true);""")
    for pid, slug, status, decision in [(PRODUCT,"qa-tech","published","review"),(HIDDEN,"qa-hidden","hidden","excluded"),(OTHER,"qa-other","draft","review"),(EDITOR,"qa-editor","draft","review")]:
        sql("INSERT INTO products(id,slug,sku,title,price,specs,status,assortment_decision) VALUES(" +
            ",".join(map(lit,[pid,slug,slug,"[Учебный] "+slug,100,"Old specs preserved",status,decision])) + ");")
    fingerprint = sql("SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM products p;")
    spec = importlib.util.spec_from_file_location("technical_dev_migration", ROOT / "ops/dev/apply-technical-catalog.py")
    operator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(operator)
    for wrong in [None, {}, {"environment":"dev"}, {"environment":"production","instanceId":operator.IDENTITY["instanceId"]}]:
        try: operator.validate_identity(wrong)
        except RuntimeError: pass
        else: raise AssertionError("INVALID_IDENTITY_ACCEPTED")
    migration17=(ROOT / "docs/migrations/0017_technical_catalog.sql").read_text()
    migration18=(ROOT / "docs/migrations/0018_technical_read_alias.sql").read_text()
    sql(operator.transaction(migration17))
    sql(operator.transaction(migration18,True))
    sql(operator.transaction(migration17),"TECH_ALREADY_APPLIED")
    sql(operator.transaction(migration18,True),"TECH_ALREADY_APPLIED")
    migration19=(ROOT / "docs/migrations/0019_technical_editor_version.sql").read_text()
    sql(operator.transaction(migration19,version_guard=True))
    sql(operator.transaction(migration19,version_guard=True),"TECH_ALREADY_APPLIED")
    migration20=(ROOT / "docs/migrations/0020_technical_editor_sessions.sql").read_text()
    sql(operator.transaction(migration20,editor_sessions=True))
    sql(operator.transaction(migration20,editor_sessions=True),"TECH_ALREADY_APPLIED")
    migration21=(ROOT / "docs/migrations/0021_editor_exclusivity.sql").read_text()
    # Migration must not silently discard pre-existing conflicting drafts.
    sql("INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at) VALUES(101,'new_title',now()+interval '1 hour');")
    sql("INSERT INTO technical_editor_sessions(staff_telegram_id,product_id,base_version,data) VALUES(101,"+lit(EDITOR)+",0,'{}');")
    sql(operator.transaction(migration21,editor_exclusive=True),"EDITOR_EXISTING_CONFLICT")
    assert sql("SELECT count(*) FROM bot_editor_states")== "1"
    assert sql("SELECT count(*) FROM technical_editor_sessions")== "1"
    sql("DELETE FROM bot_editor_states; DELETE FROM technical_editor_sessions;")
    sql(operator.transaction(migration21,editor_exclusive=True))
    sql(operator.transaction(migration21,editor_exclusive=True),"TECH_ALREADY_APPLIED")
    assert sql("SELECT has_function_privilege('service_role','bot_editor_exclusive()','EXECUTE')")=="f"
    assert sql("SELECT has_function_privilege('anon','bot_editor_exclusive()','EXECUTE')")=="f"

    ordinary = """INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at)
      VALUES(101,'new_title',now()+interval '1 hour') ON CONFLICT(staff_telegram_id)
      DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at,consumed_at=NULL;"""
    technical = "SELECT bot_technical_editor(101,'start',p_product_id=>"+lit(EDITOR)+");"
    def clear_dialogs():
        sql("UPDATE bot_editor_states SET consumed_at=now(); UPDATE technical_editor_sessions SET phase='canceled';")
    def wait_for_holder(tag):
        for _ in range(100):
            if sql("SELECT count(*) FROM pg_stat_activity WHERE application_name="+lit(tag)+" AND wait_event='PgSleep'")=="1":
                return
            time.sleep(.01)
        raise AssertionError("Competing transaction did not acquire the editor lock")
    # Force both serial orders with a live transaction, not merely sequential inserts.
    for first,second,error,tag in (
        (ordinary,technical,"EDITOR_ORDINARY_ACTIVE","qa-ordinary-first"),
        (technical,ordinary,"EDITOR_TECHNICAL_ACTIVE","qa-technical-first"),
    ):
        clear_dialogs()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            holder=pool.submit(sql,"BEGIN; SET application_name="+lit(tag)+"; "+first+" SELECT pg_sleep(2); COMMIT;")
            wait_for_holder(tag)
            contender=pool.submit(sql,second,error)
            holder.result()
            contender.result()
        assert sql("""SELECT
          (SELECT count(*) FROM bot_editor_states WHERE consumed_at IS NULL AND expires_at>now())+
          (SELECT count(*) FROM technical_editor_sessions WHERE phase IN ('editing','preview') AND expires_at>now())""")=="1"
    clear_dialogs()
    sql("BEGIN ISOLATION LEVEL REPEATABLE READ; "+ordinary+" COMMIT;","EDITOR_ISOLATION_REQUIRED")
    sql("BEGIN ISOLATION LEVEL REPEATABLE READ; "+technical+" COMMIT;","EDITOR_ISOLATION_REQUIRED")
    sql(ordinary)
    sql("UPDATE bot_editor_states SET expires_at=now()-interval '1 second';")
    sql(technical)  # Expired ordinary draft does not block a new technical dialog.
    sql("INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at) VALUES(102,'new_title',now()+interval '1 hour');")
    clear_dialogs()
    sql(ordinary)  # Explicit cancellation releases the actor's input.
    clear_dialogs()
    # These rows belong only to this disposable QA cluster; the next upgrade check requires an empty editor baseline.
    sql("DELETE FROM bot_editor_states; DELETE FROM technical_editor_sessions;")
    print("exclusive editors: both concurrent orders, expiry, cancellation, actor isolation and migration refusal PASS",flush=True)
    sql(operator.transaction(migration18,True),"TECH_ALREADY_APPLIED")
    assert sql("SELECT to_regprocedure('bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text)') IS NULL") == "t"
    # Exercise the production rehearsal checks in this disposable, no-network QA cluster.
    # Never change the identity of an actual DEV/production database.
    upgrade_checks=(ROOT / "ops/standalone/check-technical-upgrade.sql").read_text()
    sql(upgrade_checks,"REHEARSAL_SYNTHETIC_ACCEPTED_OUTSIDE_DEV")
    sql("""CREATE OR REPLACE FUNCTION mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $f$
      SELECT '{"environment":"production","instanceId":"00000000-0000-4000-8000-000000000020"}'::jsonb $f$""")
    sql("GRANT SELECT ON technical_editor_sessions TO anon")
    sql(upgrade_checks,"REHEARSAL_TECH_DIRECT_ACCESS")
    sql("REVOKE SELECT ON technical_editor_sessions FROM anon")
    checked=json.loads(sql(upgrade_checks))
    assert checked["editorApplyDuplicateUndo"] and checked["fixturesRolledBack"]
    assert sql("SELECT count(*) FROM technical_editor_sessions")=="0"
    assert fingerprint == sql("SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM products p;")
    sql("""CREATE OR REPLACE FUNCTION mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $f$
      SELECT '{"environment":"dev","instanceId":"3a6a67bc-5ce6-46a4-af72-e6ab78800e49"}'::jsonb $f$""")
    dictionary = json.loads((ROOT / "src/lib/technical/pilot-dictionary.json").read_text())
    assert int(sql("SELECT count(*) FROM technical_attributes")) == len(dictionary["attributes"])
    for attr in dictionary["attributes"]:
        stored = json.loads(sql("SELECT to_jsonb(a) FROM technical_attributes a WHERE code=" + lit(attr["code"])))
        assert stored == attr, (stored, attr)
    assert public() is None
    empty = rpc("read")
    assert empty["card"] == {"version":0,"published_revision":None,"published":None,"revisions":[]}
    for role in ["anon", "authenticated", "service_role"]:
        sql(f"SET ROLE {role}; SELECT * FROM technical_revisions;", "permission denied")
        sql(f"SET ROLE {role}; DELETE FROM technical_changes;", "permission denied")
    sql("SET ROLE anon; SELECT bot_technical_catalog(101,'read');", "permission denied")
    sql("SET ROLE service_role; SELECT validate_technical_document('{}','verified');", "permission denied")
    for actor in [104,105,999]:
        rpc("preview", DOC, actor=actor, error="TECH_DENIED")
    rpc("preview", DOC, "verified", actor=103, error="TECH_REVIEW_DENIED")
    for version in [None,-1,9007199254740992]:
        rpc("preview", DOC, "verified", expected_version=version, error="TECH_VERSION_REQUIRED")
    assert sql("SELECT count(*) FROM technical_cards") == "0"
    initial_version = rpc("read")["card"]["version"]
    b = rpc("preview", DOC, "verified", expected_version=initial_version)
    rpc("apply", change=b["change_id"], actor=102, error="TECH_CHANGE_NOT_FOUND")
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(lambda _: rpc("apply", change=b["change_id"]), range(8)))
    assert sum(x.get("duplicate", False) for x in outcomes) == 7
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='technical_apply'") == "1"
    published = public()
    staff_read = rpc("read",actor=103)
    assert staff_read["card"]["published_revision"] == published["revision_id"]
    assert len(staff_read["card"]["revisions"]) == 1
    assert staff_read["card"]["revisions"][0]["document"] == DOC
    assert published["values"][0]["code"]  # explicit values, not raw revision/staff fields
    assert "staff_telegram_id" not in json.dumps(published)
    numbers = {(x["code"],x["process"]):x["value"] for x in published["values"]}
    assert numbers["mig_current_max_a","mig"] == 200 and numbers["mma_current_max_a","mma"] == 160
    assert numbers["tig_current_max_a","tig"] is None
    assert numbers["power_consumption_kva","mma"] != numbers["power_consumption_kva","mig"]
    assert staff_read["card"]["published"]["document"] == DOC
    # Read-to-preview conflict: no preview/card/audit write survives the rejected attempt.
    changes_before = sql("SELECT count(*) FROM technical_changes")
    audits_before = sql("SELECT count(*) FROM staff_audit_log WHERE action='technical_preview'")
    rpc("preview", DOC, "verified", expected_version=initial_version, error="TECH_CONFLICT")
    assert sql("SELECT count(*) FROM technical_changes") == changes_before
    assert sql("SELECT count(*) FROM staff_audit_log WHERE action='technical_preview'") == audits_before
    assert public() == published
    # A seller's proposal and a conflict keep the published revision unchanged.
    proposal = preview_apply(review="pending_review", actor=103)
    assert public() == published
    conflict = preview_apply(review="conflict")
    assert public() == published
    rpc("undo", change=conflict["change_id"])
    rpc("undo", change=conflict["change_id"])  # idempotent undo
    assert public() == published
    rpc("undo", change=b["change_id"], error="TECH_CONFLICT")
    # Two separately owned previews cannot overwrite one another.
    first=rpc("preview", DOC, "verified")
    second=rpc("preview", DOC, "verified", actor=102)
    rpc("apply", change=first["change_id"])
    rpc("apply", change=second["change_id"], actor=102, error="TECH_CONFLICT")
    rpc("undo", change=first["change_id"])
    assert public() == published
    # Revocation and expiry are checked again at confirmation.
    revoked=rpc("preview",DOC,actor=103)
    sql("UPDATE staff SET active=false WHERE telegram_id=103")
    rpc("apply",change=revoked["change_id"],actor=103,error="TECH_DENIED")
    sql("UPDATE staff SET active=true WHERE telegram_id=103")
    expired=rpc("preview",DOC)
    sql("UPDATE technical_changes SET expires_at=now()-interval '1 second' WHERE id="+lit(expired["change_id"]))
    rpc("apply",change=expired["change_id"],error="TECH_PREVIEW_EXPIRED")
    # The audit is part of the same transaction, not a best-effort follow-up.
    audit=rpc("preview",DOC)
    version=sql("SELECT version FROM technical_cards WHERE product_id="+lit(PRODUCT))
    sql("""CREATE FUNCTION reject_tech_audit() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
      IF NEW.action='technical_apply' THEN RAISE EXCEPTION 'QA_AUDIT'; END IF; RETURN NEW; END $f$;
      CREATE TRIGGER reject_tech_audit BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION reject_tech_audit();""")
    rpc("apply",change=audit["change_id"],error="QA_AUDIT")
    assert sql("SELECT state FROM technical_changes WHERE id="+lit(audit["change_id"])) == "preview"
    assert sql("SELECT version FROM technical_cards WHERE product_id="+lit(PRODUCT)) == version
    sql("DROP TRIGGER reject_tech_audit ON staff_audit_log")
    # Type/process/unit/provenance and professional context rejection.
    cases=[]
    d=copy.deepcopy(DOC); d["values"][0]["process"]="mma"; cases.append((d,"TECH_BAD_VALUE"))
    d=copy.deepcopy(DOC); d["values"][0]["unit_code"]="kw"; cases.append((d,"TECH_BAD_VALUE"))
    d=copy.deepcopy(DOC); d["values"][0]["value"]="200"; cases.append((d,"TECH_BAD_TYPE"))
    d=copy.deepcopy(DOC); d["values"][2]["context"].pop("temperature_c"); cases.append((d,"TECH_CONTEXT_REQUIRED"))
    d=copy.deepcopy(DOC); d["values"][2]["value"]=101; cases.append((d,"TECH_BAD_RANGE"))
    d=copy.deepcopy(DOC); d["values"][4]["value"]=False; cases.append((d,"TECH_UNKNOWN_HAS_VALUE"))
    d=copy.deepcopy(DOC); d["sources"][0]["kind"]="research"; cases.append((d,"TECH_PRIMARY_SOURCE_REQUIRED"))
    d=copy.deepcopy(DOC); d["sources"][0]["locator"]=""; cases.append((d,"TECH_BAD_SOURCE"))
    d=copy.deepcopy(DOC); d["sources"][0]["url"]="https://example.invalid/private?token=secret"; cases.append((d,"TECH_BAD_SOURCE"))
    d=copy.deepcopy(DOC); d["sources"][0]["checked_on"]="2099-01-01"; cases.append((d,"TECH_BAD_SOURCE"))
    d=copy.deepcopy(DOC); d["values"][0]["source_key"]="missing"; cases.append((d,"TECH_SOURCE_REQUIRED"))
    d=copy.deepcopy(DOC); d["values"].append(value("mig_current_min_a",201,"mig","a")); cases.append((d,"TECH_REVERSED_RANGE"))
    d=copy.deepcopy(DOC); d["values"].append(copy.deepcopy(d["values"][0])); cases.append((d,"TECH_BAD_VALUE"))
    d=copy.deepcopy(DOC); d["values"][3]["value"]=[1,1]; cases.append((d,"TECH_DUPLICATE_VALUE"))
    d=copy.deepcopy(DOC); d["values"][0]["attribute_code"]="compatibility_guaranteed"; cases.append((d,"TECH_ATTRIBUTE_NOT_APPLICABLE"))
    for doc,error in cases: rpc("preview",doc,"verified",error=error)
    tig=document("power_tig_dc",[value("tig_polarity_modes",["dc"],"tig"),value("tig_pulse",False,"tig"),value("tig_start_modes",["lift"],"tig")])
    preview_apply(tig,product=OTHER)
    assert public(OTHER) is None  # draft stays private despite verified technical data
    tig["values"][0]["value"]=["ac"]
    rpc("preview",tig,"verified",error="TECH_BAD_OPTION")
    cut=document("power_cut",[value("cut_recommended_thickness_mm",10,"cut","mm",{"material":"steel"}),
       value("cut_severance_thickness_mm",15,"cut","mm",{"material":"steel"}),
       value("cut_piercing_thickness_mm",5,"cut","mm",{"material":"steel"}),
       value("compressed_air_flow_l_min",100,"cut","l_min",{"pressure_bar":4})])
    preview_apply(cut,product=HIDDEN)
    assert public(HIDDEN) is None
    cut["values"][-1]["context"]={}
    rpc("preview",cut,"verified",error="TECH_CONTEXT_REQUIRED")
    torch=document("mig_torch",[value("mig_torch_amp_co2_a",150,"mig","a",
      {"gas":"CO2","cooling":"air","duty_pct":60,"temperature_c":40})])
    rpc("preview",torch,"verified")
    torch["values"][0]["context"]["gas"]="M21"
    rpc("preview",torch,"verified",error="TECH_CONTEXT_REQUIRED")
    wire=document("consumable_flux_wire",[value("flux_wire_gas_mode","self_shielded"),value("wire_diameter_mm",.8,unit="mm"),value("wire_spool_net_mass_kg",1,unit="kg")])
    rpc("preview",wire,"verified")
    wire["values"][0]["value"]="gas_shielded"; rpc("preview",wire,"verified")
    electrode=document("consumable_mma_electrodes",[value("electrode_current_min_a",60,"mma","a",{"diameter_mm":2.5}),value("electrode_current_max_a",90,"mma","a",{"diameter_mm":2.5})])
    rpc("preview",electrode,"verified")
    electrode["values"][0]["context"]={}; rpc("preview",electrode,"verified",error="TECH_CONTEXT_REQUIRED")
    mask=document("mask_adf",[value("mask_dark_shade_min_din",9,unit="din"),value("mask_optical_class","1/1/1/2"),value("mask_grinding_mode",False)])
    rpc("preview",mask,"verified")
    # Synthetic source must be rejected in production and on an unknown identity.
    for identity in ['{"environment":"production"}','{}']:
        sql("CREATE OR REPLACE FUNCTION mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $f$ SELECT '"+identity+"'::jsonb $f$")
        rpc("preview",DOC,"verified",error="TECH_SYNTHETIC_DEV_ONLY")
    sql("""CREATE OR REPLACE FUNCTION mw_environment_identity() RETURNS jsonb LANGUAGE sql AS $f$ SELECT '{"environment":"dev"}'::jsonb $f$""")
    assert fingerprint == sql("SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM products p;")
    assert sql("SELECT count(*) FROM order_notifications") == "0"
    assert sql("SELECT count(*) FROM shop_orders") == "0"
    # More than ten proposals cannot make the approved base document disappear.
    for _ in range(11): preview_apply(review="pending_review",actor=103)
    history=rpc("read",actor=103)["card"]
    assert len(history["revisions"]) == 10
    assert published["revision_id"] not in [r["id"] for r in history["revisions"]]
    assert history["published"]["id"] == published["revision_id"]
    assert history["published"]["document"] == DOC
    # Durable editor: actor ownership, CAS, atomic preview/apply, stale base, restart.
    def editor(op, session=None, actor=101, error=None, **extra):
        args={"p_staff_telegram_id":actor,"p_op":op}
        if session: args.update(p_session_id=session["id"],p_revision=session["revision"])
        args.update(extra)
        result=sql("SET ROLE service_role; SELECT bot_technical_editor("+",".join(k+"=>"+lit(json.dumps(v) if isinstance(v,dict) else v) for k,v in args.items())+");",error)
        return json.loads(result)["session"] if not error else None
    for role in ["anon","authenticated","service_role"]:
        sql("SET ROLE "+role+"; SELECT * FROM technical_editor_sessions;","permission denied")
    sql("SET ROLE anon; SELECT bot_technical_editor(101,'current');","permission denied")
    for actor in [104,105,999]:
        editor("start",actor=actor,p_product_id=EDITOR,error="TECH_DENIED")
    draft=editor("start",p_product_id=EDITOR)
    assert draft["base_version"]==0 and draft["base_document"] is None
    editor("start",p_product_id=PRODUCT,error="TECH_EDITOR_ACTIVE")
    editor("get",draft,actor=102,error="TECH_EDITOR_NOT_FOUND")
    state={**draft["data"],"document":DOC}
    # Exactly one racing save wins; the loser must not overwrite it.
    def racing_save():
        try: return editor("save",draft,p_data=state)
        except RuntimeError as exc:
            assert "TECH_EDITOR_STALE" in str(exc)
            return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        outcomes=list(pool.map(lambda _: racing_save(),range(2)))
    assert sum(v is not None for v in outcomes)==1
    draft=next(v for v in outcomes if v is not None)
    prompted=editor("prompt",draft,p_prompt_message_id=321)
    assert prompted["prompt_message_id"]==321 and prompted["revision"]==draft["revision"]
    # Audit failure rolls back the nested core preview and session transition together.
    sql("""CREATE FUNCTION reject_editor_audit() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
      IF NEW.action='technical_editor_preview' THEN RAISE EXCEPTION 'QA_EDITOR_AUDIT_FAILURE'; END IF;
      RETURN NEW; END $f$;
      CREATE TRIGGER reject_editor_audit BEFORE INSERT ON staff_audit_log FOR EACH ROW EXECUTE FUNCTION reject_editor_audit();""")
    changes=sql("SELECT count(*) FROM technical_changes")
    editor("preview",draft,p_review_state="verified",error="QA_EDITOR_AUDIT_FAILURE")
    assert editor("get",draft)["phase"]=="editing"
    assert sql("SELECT count(*) FROM technical_changes")==changes
    sql("DROP TRIGGER reject_editor_audit ON staff_audit_log; DROP FUNCTION reject_editor_audit();")
    preview=editor("preview",draft,p_review_state="verified")
    applied=editor("apply",preview)
    assert applied["phase"]=="applied"
    assert editor("apply",preview)["applied_revision"]==applied["applied_revision"]
    assert editor("latest")["id"]==applied["id"]
    assert editor("current") is None
    undone=editor("undo",applied)
    assert editor("undo",applied)["phase"]=="undone"
    seller=editor("start",actor=103,p_product_id=EDITOR)
    seller=editor("save",seller,actor=103,p_data=state)
    editor("preview",seller,actor=103,p_review_state="verified",error="TECH_REVIEW_DENIED")
    seller=editor("apply",editor("preview",seller,actor=103),actor=103)
    # A reviewable proposal is copied explicitly; starting it never changes publication.
    editor("start",actor=102,p_source_revision=seller["applied_revision"],p_product_id=PRODUCT,error="TECH_REVIEW_DENIED")
    review=editor("start",p_source_revision=seller["applied_revision"])
    assert review["product_id"]==EDITOR and review["data"]["document"]==DOC
    assert public(EDITOR) is None
    editor("cancel",review)
    # Seller cannot copy an unrelated administrator's revision.
    editor("start",actor=103,p_source_revision=applied["applied_revision"],error="TECH_REVIEW_DENIED")
    stale=editor("start",p_product_id=EDITOR)
    preview_apply(product=EDITOR,actor=102)
    editor("preview",stale,error="TECH_CONFLICT")
    assert editor("get",stale)["base_version"]==stale["base_version"]
    editor("cancel",stale)
    expired=editor("start",p_product_id=EDITOR)
    sql("UPDATE technical_editor_sessions SET expires_at=now()-interval '1 second' WHERE id="+lit(expired["id"]))
    editor("save",expired,p_data=state,error="TECH_EDITOR_EXPIRED")
    resumed=editor("start",p_product_id=EDITOR)
    assert resumed["id"]!=expired["id"]
    resumed=editor("save",resumed,p_data=state)
    sql("UPDATE staff SET active=false WHERE telegram_id=101")
    editor("get",resumed,error="TECH_DENIED")
    sql("UPDATE staff SET active=true WHERE telegram_id=101")
    # Restart retains public pointer, proposals, audit, editor and idempotency.
    run(["docker","restart",NAME])
    for _ in range(120):
        if subprocess.run(["docker","exec",NAME,"pg_isready","-h","127.0.0.1","-U","postgres"],capture_output=True).returncode==0: break
        time.sleep(.25)
    assert public() == published
    assert editor("current")["data"]==state
    assert rpc("apply",change=b["change_id"])["duplicate"]
    dump = subprocess.run(["docker","exec",NAME,"pg_dump","-U","postgres","-d","postgres","-Fc"],check=True,capture_output=True).stdout
    run(["docker","exec",NAME,"createdb","-U","postgres","restored"])
    subprocess.run(["docker","exec","-i",NAME,"pg_restore","-U","postgres","-d","restored","--single-transaction","--exit-on-error"],
                   input=dump,check=True,capture_output=True)
    assert json.loads(sql("SET ROLE anon; SELECT public_product_technical("+lit(PRODUCT)+");",db="restored")) == published
    assert fingerprint == sql("SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM products p;",db="restored")
    print(json.dumps({"dictionary":len(dictionary["attributes"]),"families":48,"concurrentSingleApply":True,
      "editorOwnershipCasRestart":True,"editorPreviewAuditAtomic":True,"editorApplyDuplicate":True,"readToPreviewConflict":True,"publishedOutsideHistory":True,"pendingKeepsPublished":True,"conflictUndo":True,"revocationExpiry":True,"atomicAudit":True,
      "typedContextsSources":True,"publicScope":True,"productsUnchanged":True,"restartPreserved":True,"dumpRestored":True}))
finally:
    if created: subprocess.run(["docker","rm","-fv",NAME],capture_output=True)
