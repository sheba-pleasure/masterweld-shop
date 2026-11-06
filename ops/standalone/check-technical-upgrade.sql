-- Run ONLY in an isolated rehearsal database. All fixtures roll back.
BEGIN;
DO $checks$
DECLARE t text; role_name text;
BEGIN
  IF (SELECT count(*) FROM technical_families)<>48
    OR (SELECT count(*) FROM technical_attributes)<>40
    OR (SELECT count(*) FROM technical_family_attributes)<>69
    OR (SELECT count(*) FROM technical_units)<>14
    THEN RAISE EXCEPTION 'REHEARSAL_TECH_DICTIONARY_MISMATCH'; END IF;
  FOREACH t IN ARRAY ARRAY['technical_cards','technical_revisions','technical_changes','technical_editor_sessions','bot_draft_results'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',t) INTO strict role_name;
    IF role_name::boolean THEN RAISE EXCEPTION 'REHEARSAL_UNEXPECTED_TECH_BACKFILL'; END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['technical_units','technical_families','technical_attributes','technical_family_attributes',
      'technical_cards','technical_revisions','technical_changes','technical_editor_sessions','bot_draft_results'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass)
      THEN RAISE EXCEPTION 'REHEARSAL_TECH_RLS_DISABLED'; END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
        THEN RAISE EXCEPTION 'REHEARSAL_TECH_DIRECT_ACCESS'; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
    AND p.oid<>'public.public_product_technical(uuid)'::regprocedure
    AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE')))
    THEN RAISE EXCEPTION 'REHEARSAL_UNEXPECTED_PUBLIC_DEFINER'; END IF;
  IF NOT has_function_privilege('anon','public.public_product_technical(uuid)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.public_product_technical(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'REHEARSAL_PUBLIC_TECH_READ_MISSING'; END IF;
  IF to_regprocedure('public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text)') IS NOT NULL
    THEN RAISE EXCEPTION 'REHEARSAL_OBSOLETE_PREVIEW_SIGNATURE'; END IF;
  IF to_regprocedure('public.bot_editor_exclusive()') IS NULL
    THEN RAISE EXCEPTION 'REHEARSAL_EDITOR_GUARD_MISSING'; END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
    AND tgfoid='public.bot_editor_exclusive()'::regprocedure
    AND ((tgrelid='public.bot_editor_states'::regclass AND tgname='bot_editor_exclusive_guard')
      OR (tgrelid='public.technical_editor_sessions'::regclass AND tgname='technical_editor_exclusive_guard')))<>2
    THEN RAISE EXCEPTION 'REHEARSAL_EDITOR_TRIGGER_MISSING'; END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_function_privilege(role_name,'public.bot_editor_exclusive()','EXECUTE')
      THEN RAISE EXCEPTION 'REHEARSAL_EDITOR_GUARD_EXPOSED'; END IF;
  END LOOP;
  IF has_function_privilege('service_role','public.bot_create_draft(bigint,text,text,numeric)','EXECUTE')
    THEN RAISE EXCEPTION 'REHEARSAL_DRAFT_BYPASS_OPEN'; END IF;
  IF NOT has_function_privilege('service_role','public.bot_finish_draft(bigint,uuid,boolean)','EXECUTE')
    THEN RAISE EXCEPTION 'REHEARSAL_DRAFT_RPC_UNAVAILABLE'; END IF;
  IF EXISTS(SELECT 1 FROM staff WHERE telegram_id=7000000000000001)
    OR EXISTS(SELECT 1 FROM products WHERE id='f0000000-0000-4000-8000-000000000020'
      OR slug='qa-private-upgrade-0020')
    THEN RAISE EXCEPTION 'REHEARSAL_FIXTURE_COLLISION'; END IF;
  INSERT INTO staff(telegram_id,name,role,active,elevated)
    VALUES(7000000000000001,'[Учебный] Offline upgrade QA','admin',true,false);
  INSERT INTO products(id,slug,sku,title,price,status,assortment_decision)
    VALUES('f0000000-0000-4000-8000-000000000020','qa-private-upgrade-0020','QA-PRIVATE-0020',
      '[Учебный] Только транзакция репетиции',1,'draft','review');
END $checks$;
SET LOCAL ROLE anon;
DO $public$ BEGIN
  IF EXISTS(SELECT 1 FROM products WHERE public_product_technical(id) IS NOT NULL)
    THEN RAISE EXCEPTION 'REHEARSAL_INVENTED_PUBLIC_FACTS'; END IF;
END $public$;
SET LOCAL ROLE service_role;
DO $editor$
DECLARE actor bigint:=7000000000000001; e jsonb; applied jsonb; doc jsonb; state jsonb; denied boolean:=false;
BEGIN
  INSERT INTO bot_editor_states(staff_telegram_id,state,expires_at)
    VALUES(actor,'new_title',now()+interval '1 hour');
  BEGIN
    PERFORM bot_technical_editor(actor,'start',p_product_id=>'f0000000-0000-4000-8000-000000000020');
    RAISE EXCEPTION 'REHEARSAL_ORDINARY_DIALOG_OVERWRITTEN';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'EDITOR_ORDINARY_ACTIVE' THEN RAISE; END IF;
  END;
  IF NOT EXISTS(SELECT 1 FROM bot_editor_states b WHERE b.staff_telegram_id=actor
    AND b.state='new_title' AND b.consumed_at IS NULL)
    THEN RAISE EXCEPTION 'REHEARSAL_ORDINARY_DIALOG_LOST'; END IF;
  UPDATE bot_editor_states SET consumed_at=now() WHERE staff_telegram_id=actor;
  e:=bot_technical_editor(actor,'start',p_product_id=>'f0000000-0000-4000-8000-000000000020')->'session';
  BEGIN
    UPDATE bot_editor_states SET consumed_at=NULL WHERE staff_telegram_id=actor;
    RAISE EXCEPTION 'REHEARSAL_TECHNICAL_DIALOG_OVERWRITTEN';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'EDITOR_TECHNICAL_ACTIVE' THEN RAISE; END IF;
  END;
  IF (bot_technical_editor(actor,'current')->'session'->>'id') IS DISTINCT FROM e->>'id'
    OR EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=actor AND consumed_at IS NULL)
    THEN RAISE EXCEPTION 'REHEARSAL_TECHNICAL_DIALOG_LOST'; END IF;
  e:=bot_technical_editor(actor,'cancel',(e->>'id')::uuid,(e->>'revision')::integer)->'session';
  UPDATE bot_editor_states SET consumed_at=NULL WHERE staff_telegram_id=actor;
  UPDATE bot_editor_states SET consumed_at=now() WHERE staff_telegram_id=actor;
  e:=bot_technical_editor(actor,'start',p_product_id=>'f0000000-0000-4000-8000-000000000020')->'session';
  IF (e->>'base_version')::bigint<>0 THEN RAISE EXCEPTION 'REHEARSAL_BASE_VERSION'; END IF;
  doc:=jsonb_build_object('family_code','power_mma','sources',jsonb_build_array(jsonb_build_object(
    'key','qa','kind','synthetic','publisher','QA','model','QA','title','[Учебный] Не паспорт',
    'url','https://example.invalid/qa','locator','QA','checked_on',current_date::text,'sha256','')),
    'values','[]'::jsonb);
  state:=jsonb_set(e->'data','{document}',doc);
  e:=bot_technical_editor(actor,'save',(e->>'id')::uuid,(e->>'revision')::integer,p_data=>state)->'session';
  BEGIN
    PERFORM bot_technical_editor(actor,'preview',(e->>'id')::uuid,(e->>'revision')::integer,p_review_state=>'verified');
  EXCEPTION
    WHEN undefined_function THEN
      -- A Cloud data-only copy has no environment marker. It must not accept DEV fixtures.
      IF to_regprocedure('public.mw_environment_identity()') IS NOT NULL THEN RAISE; END IF;
      denied:=true;
    WHEN raise_exception THEN
      IF SQLERRM<>'TECH_SYNTHETIC_DEV_ONLY' THEN RAISE; END IF;
      denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'REHEARSAL_SYNTHETIC_ACCEPTED_OUTSIDE_DEV'; END IF;
  doc:='{"family_code":"power_mma","sources":[],"values":[{"attribute_code":"mma_current_max_a","process":"mma","state":"unknown","value":null,"unit_code":"a","context":{},"source_key":null}]}'::jsonb;
  state:=jsonb_set(e->'data','{document}',doc);
  e:=bot_technical_editor(actor,'save',(e->>'id')::uuid,(e->>'revision')::integer,p_data=>state)->'session';
  e:=bot_technical_editor(actor,'preview',(e->>'id')::uuid,(e->>'revision')::integer)->'session';
  applied:=bot_technical_editor(actor,'apply',(e->>'id')::uuid,(e->>'revision')::integer)->'session';
  IF applied->>'phase'<>'applied' OR (bot_technical_editor(actor,'apply',(e->>'id')::uuid,(e->>'revision')::integer)->'session'->>'applied_revision')
    IS DISTINCT FROM applied->>'applied_revision' THEN RAISE EXCEPTION 'REHEARSAL_EDITOR_DUPLICATE'; END IF;
  e:=bot_technical_editor(actor,'undo',(applied->>'id')::uuid,(applied->>'revision')::integer)->'session';
  IF e->>'phase'<>'undone' THEN RAISE EXCEPTION 'REHEARSAL_EDITOR_UNDO'; END IF;
END $editor$;
DO $draft$
DECLARE actor bigint:=7000000000000001; revision uuid:=gen_random_uuid(); canceled uuid:=gen_random_uuid();
  answer jsonb; repeated jsonb; later jsonb; before_count bigint;
BEGIN
  SELECT count(*) INTO before_count FROM products;
  UPDATE bot_editor_states SET state='new_confirm',consumed_at=NULL,
    data=jsonb_build_object('_revision',revision,'title','[Учебный] Offline recovery fixture',
      'sku',NULL,'price',1),expires_at=now()+interval '1 hour' WHERE staff_telegram_id=actor;
  answer:=bot_finish_draft(actor,revision,true);
  IF answer->>'outcome'<>'created' OR answer->>'product_id' IS NULL
    THEN RAISE EXCEPTION 'REHEARSAL_DRAFT_NOT_CREATED'; END IF;
  IF NOT EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=actor AND consumed_at IS NOT NULL)
    THEN RAISE EXCEPTION 'REHEARSAL_DRAFT_NOT_CONSUMED'; END IF;
  UPDATE bot_editor_states SET state='new_title',consumed_at=NULL,
    data=jsonb_build_object('_revision',gen_random_uuid()) WHERE staff_telegram_id=actor;
  SELECT to_jsonb(e) INTO later FROM bot_editor_states e WHERE staff_telegram_id=actor;
  repeated:=bot_finish_draft(actor,revision,true);
  IF repeated->>'product_id' IS DISTINCT FROM answer->>'product_id' OR repeated->>'replayed'<>'true'
    OR (bot_finish_draft(actor,revision,false)->>'outcome')<>'created'
    OR (SELECT to_jsonb(e) FROM bot_editor_states e WHERE staff_telegram_id=actor) IS DISTINCT FROM later
    OR (SELECT count(*) FROM products)<>before_count+1
    THEN RAISE EXCEPTION 'REHEARSAL_DRAFT_RECOVERY_CHANGED'; END IF;
  UPDATE bot_editor_states SET state='new_confirm',
    data=jsonb_build_object('_revision',canceled,'title','[Учебный] Canceled fixture','sku',NULL,'price',1)
    WHERE staff_telegram_id=actor;
  IF bot_finish_draft(actor,canceled,false)->>'outcome'<>'canceled'
    OR bot_finish_draft(actor,canceled,true)->>'outcome'<>'canceled'
    OR (SELECT count(*) FROM products)<>before_count+1
    THEN RAISE EXCEPTION 'REHEARSAL_DRAFT_CANCEL_CHANGED'; END IF;
END $draft$;
RESET ROLE;
DO $receipts$ BEGIN
  IF (SELECT count(*) FROM bot_draft_results WHERE staff_telegram_id=7000000000000001)<>2
    OR (SELECT count(*) FROM staff_audit_log WHERE telegram_id=7000000000000001 AND action='draft_created')<>1
    THEN RAISE EXCEPTION 'REHEARSAL_DRAFT_RECEIPT_COUNT'; END IF;
END $receipts$;
ROLLBACK;
SELECT jsonb_build_object(
  'families',48,'attributes',40,'bindings',69,'units',14,
  'noTechnicalBackfill',true,'privateTablesAndRpc',true,'publicReadOnlyAllowlist',true,
  'syntheticRejectedOutsideDev',true,'editorApplyDuplicateUndo',true,'fixturesRolledBack',true,
  'exclusiveEditorTriggers',true,'bothDialogConflictsPreserveFirst',true,'cancelReleasesInput',true,
  'draftReceiptPrivate',true,'draftRecoveryPreservesNewInput',true,'draftCancelDurable',true);
