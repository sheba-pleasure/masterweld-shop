-- ONLY disposable offline upgrade/restore copies. No transport or live database writes.
-- The callers verify table fingerprints before/after this fully rolled-back probe.
BEGIN;
DO $guard$
DECLARE t text; role_name text; populated boolean; signature text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_intakes','document_import_links','staff_enrollment_results',
    'document_reviews','document_review_rows','document_review_prompts',
    'document_import_origins','document_structure_changes','document_model_checks',
    'document_model_decisions','document_import_model_links','document_import_model_comparisons',
    'document_import_model_resolutions'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I)',t) INTO populated;
    IF populated THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_UNEXPECTED_BACKFILL'; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass)
      THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_RLS_DISABLED'; END IF;
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(role_name,'public.'||t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
        THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_DIRECT_ACCESS'; END IF;
    END LOOP;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'public.bot_enroll_sellers(bigint,text,bigint[])',
    'public.bot_document_intake(bigint,text,uuid,jsonb)',
    'public.document_worker(text,uuid,uuid,jsonb)',
    'public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb)',
    'public.bot_document_model(bigint,text,uuid,integer,integer,jsonb)',
    'public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)',
    'public.bot_product_document_models(bigint,uuid,integer)'] LOOP
    IF NOT has_function_privilege('service_role',signature,'EXECUTE')
      OR has_function_privilege('anon',signature,'EXECUTE')
      OR has_function_privilege('authenticated',signature,'EXECUTE')
      THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_RPC_ACL'; END IF;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'mw_private.bot_document_intake(bigint,text,uuid,jsonb)',
    'mw_private.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)',
    'mw_private.document_structure(bigint,text,uuid,integer,integer,integer,jsonb)',
    'public.document_review_exclusive()',
    'mw_private.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb)',
    'mw_private.bot_catalog_import_models(bigint,text,uuid,jsonb,integer,integer)',
    'mw_private.document_product_identity(public.products)',
    'mw_private.document_import_model_view(bigint,uuid,integer)',
    'mw_private.document_model_evidence(uuid)'] LOOP
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_function_privilege(role_name,signature,'EXECUTE')
        THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_BYPASS_OPEN'; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM staff WHERE telegram_id BETWEEN 9100000028001 AND 9100000028004)
    THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_FIXTURE_COLLISION'; END IF;
  INSERT INTO staff(telegram_id,name,role,active,elevated) VALUES
    (9100000028001,'Offline document owner','admin',true,false),
    (9100000028002,'Offline other owner','admin',true,false),
    (9100000028003,'Offline seller','seller',true,false);
END $guard$;
CREATE TEMP TABLE document_probe(document_id uuid,review_id uuid,import_id uuid,extraction jsonb);
GRANT SELECT,INSERT ON document_probe TO service_role;
SET LOCAL ROLE service_role;
DO $flow$
DECLARE actor bigint:=9100000028001; d jsonb; d2 jsonb; c jsonb; extraction jsonb; r jsonb;
  rid uuid; did uuid; base integer; child integer; handed jsonb; enrollment jsonb;
BEGIN
  enrollment:=bot_enroll_sellers(actor,'offline-document-0028',ARRAY[9100000028004::bigint]);
  IF bot_enroll_sellers(actor,'offline-document-0028',ARRAY[9100000028004::bigint]) IS DISTINCT FROM enrollment
    OR enrollment->>'role'<>'seller' THEN RAISE EXCEPTION 'REHEARSAL_ENROLLMENT_RECEIPT'; END IF;
  BEGIN
    PERFORM bot_document_intake(9100000028003,'home');
    RAISE EXCEPTION 'REHEARSAL_SELLER_DOCUMENT_ACCESS';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_DENIED' THEN RAISE; END IF; END;
  d:=bot_document_intake(actor,'upload',NULL,jsonb_build_object('file_name','offline-upgrade.tsv',
    'base64',encode(convert_to('Offline document upgrade fixture','UTF8'),'base64')));
  did:=(d->>'id')::uuid;
  d2:=bot_document_intake(actor,'upload',NULL,jsonb_build_object('file_name','offline-upgrade.tsv',
    'base64',encode(convert_to('Offline document upgrade fixture','UTF8'),'base64')));
  IF d2->>'id' IS DISTINCT FROM d->>'id' THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_DUPLICATE'; END IF;
  BEGIN
    PERFORM bot_document_intake(9100000028002,'get',did);
    RAISE EXCEPTION 'REHEARSAL_OTHER_OWNER_ACCESS';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_NOT_FOUND' THEN RAISE; END IF; END;
  c:=document_worker('claim');
  IF c->>'id' IS DISTINCT FROM d->>'id' THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_CLAIM'; END IF;
  extraction:=jsonb_build_object('version','document-v1','sha256',d->>'checksum',
    'tables','[{"label":"Offline table","header":["sku","Wrong name","price"],
      "rows":[["QA-A\nQA-B","Alpha\nBeta","10"],["QA-C","Gamma","30"],["QA-D","Skip","40"]],
      "row_locators":["sheet:1/row:2","sheet:1/row:3","sheet:1/row:4"]}]'::jsonb,
    'blocks','[]'::jsonb,'warnings','[]'::jsonb,'coverage','{"complete":true}'::jsonb);
  BEGIN
    PERFORM document_worker('finish',did,gen_random_uuid(),extraction);
    RAISE EXCEPTION 'REHEARSAL_BAD_LEASE_ACCEPTED';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_LEASE' THEN RAISE; END IF; END;
  PERFORM document_worker('finish',did,(c->>'lease')::uuid,extraction);
  BEGIN
    PERFORM bot_document_intake(actor,'table',did,'{"index":0}');
    RAISE EXCEPTION 'REHEARSAL_UNREVIEWED_TABLE_BYPASS';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_REVIEW_REQUIRED' THEN RAISE; END IF; END;
  r:=bot_document_review(actor,'open',did); rid:=(r->>'id')::uuid;
  r:=bot_document_review(actor,'approve',rid,(r->>'revision')::integer,1);
  r:=bot_document_review(actor,'exclude',rid,(r->>'revision')::integer,2);
  r:=bot_document_review(actor,'st_head',rid,(r->>'revision')::integer,0,1);
  r:=bot_document_review(actor,'st_standard',rid,(r->>'revision')::integer,0,1);
  IF r->'header'->>1<>'Wrong name' OR r->'counts'->>'approved'<>'1'
    THEN RAISE EXCEPTION 'REHEARSAL_HEADER_CHANGED_WITHOUT_CONFIRMATION'; END IF;
  BEGIN
    PERFORM bot_document_review(actor,'st_apply',rid,(r->>'revision')::integer,0);
    RAISE EXCEPTION 'REHEARSAL_STRUCTURE_WITHOUT_PREVIEW';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_STRUCTURE_PREVIEW' THEN RAISE; END IF; END;
  r:=bot_document_review(actor,'st_preview',rid,(r->>'revision')::integer,0);
  base:=(r->>'revision')::integer;
  r:=bot_document_review(actor,'st_apply',rid,base,0);
  d2:=bot_document_review(actor,'st_apply',rid,base,0);
  IF d2->>'revision' IS DISTINCT FROM r->>'revision' OR r->'header'->>1<>'title'
    OR r->'original_header'->>1<>'Wrong name' OR r->'counts'->>'approved'<>'0'
    OR r->'counts'->>'excluded'<>'1' THEN RAISE EXCEPTION 'REHEARSAL_HEADER_RECEIPT'; END IF;
  r:=bot_document_review(actor,'st_add',rid,(r->>'revision')::integer,0);
  r:=bot_document_review(actor,'st_focus',rid,(r->>'revision')::integer,0,0);
  r:=bot_document_review(actor,'st_bind',rid,(r->>'revision')::integer,0,0,'{"message_id":900}');
  BEGIN
    PERFORM bot_document_review(actor,'st_save',rid,(r->>'revision')::integer,0,0,
      '{"value":"QA-MISSING","reply_to":899}');
    RAISE EXCEPTION 'REHEARSAL_UNBOUND_DOCUMENT_REPLY';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_PROMPT' THEN RAISE; END IF; END;
  r:=bot_document_review(actor,'st_save',rid,(r->>'revision')::integer,0,0,
    '{"value":"QA-MISSING","reply_to":900}');
  r:=bot_document_review(actor,'st_where',rid,(r->>'revision')::integer,0,-1);
  r:=bot_document_review(actor,'st_preview',rid,(r->>'revision')::integer,0);
  r:=bot_document_review(actor,'st_apply',rid,(r->>'revision')::integer,0);
  IF r->>'source_origin'<>'manual' OR r->>'decision'<>'pending' OR r->'counts'->>'total'<>'4'
    THEN RAISE EXCEPTION 'REHEARSAL_MANUAL_ROW_ORIGIN'; END IF;
  r:=bot_document_review(actor,'st_undo',rid,(r->>'revision')::integer,(r->>'row')::integer);
  IF r->'counts'->>'total'<>'3' THEN RAISE EXCEPTION 'REHEARSAL_STRUCTURE_UNDO'; END IF;
  r:=bot_document_review(actor,'st_split',rid,(r->>'revision')::integer,0,2);
  IF r->'structure_draft'->'rows' IS DISTINCT FROM '[["QA-A","Alpha",""],["QA-B","Beta",""]]'::jsonb
    THEN RAISE EXCEPTION 'REHEARSAL_SPLIT_AMBIGUOUS_VALUE'; END IF;
  r:=bot_document_review(actor,'st_preview',rid,(r->>'revision')::integer,0);
  base:=(r->>'revision')::integer;
  r:=bot_document_review(actor,'st_apply',rid,base,0); child:=(r->>'row')::integer;
  d2:=bot_document_review(actor,'st_apply',rid,base,0);
  IF r->>'source_origin'<>'split' OR child<>4 OR r->'counts'->>'total'<>'4'
    OR d2->>'revision' IS DISTINCT FROM r->>'revision'
    THEN RAISE EXCEPTION 'REHEARSAL_SPLIT_STABLE_RECEIPT'; END IF;
  BEGIN
    PERFORM bot_document_review(actor,'approve',rid,(r->>'revision')::integer,0);
    RAISE EXCEPTION 'REHEARSAL_RETIRED_ROW_REDIRECTED_WRITE';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_ROW_REPLACED' THEN RAISE; END IF; END;
  BEGIN
    PERFORM bot_document_review(actor,'handoff',rid,(r->>'revision')::integer,child);
    RAISE EXCEPTION 'REHEARSAL_HUMAN_DECISION_BYPASS';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_UNREVIEWED' THEN RAISE; END IF; END;
  WHILE (r->'counts'->>'pending')::integer>0 LOOP
    r:=bot_document_review(actor,'next',rid,NULL,(r->>'row')::integer);
    r:=bot_document_review(actor,'approve',rid,(r->>'revision')::integer,(r->>'row')::integer);
  END LOOP;
  base:=(r->>'revision')::integer;
  handed:=bot_document_review(actor,'handoff',rid,base,child);
  IF bot_document_review(actor,'handoff',rid,base,child) IS DISTINCT FROM handed
    THEN RAISE EXCEPTION 'REHEARSAL_HANDOFF_DUPLICATE'; END IF;
  d2:=bot_document_intake(actor,'get',did);
  IF d2->'extraction' IS DISTINCT FROM extraction THEN RAISE EXCEPTION 'REHEARSAL_ORIGINAL_EXTRACTION_CHANGED'; END IF;
  INSERT INTO document_probe VALUES(did,rid,(handed->>'import_id')::uuid,extraction);
END $flow$;
RESET ROLE;
DO $result$
DECLARE d document_probe%ROWTYPE; imported catalog_imports%ROWTYPE;
BEGIN
  SELECT * INTO STRICT d FROM document_probe;
  SELECT * INTO STRICT imported FROM catalog_imports WHERE id=d.import_id;
  IF imported.state<>'config' OR imported.source->'rows'
      IS DISTINCT FROM '[["QA-A","Alpha",""],["QA-B","Beta",""],["QA-C","Gamma","30"]]'::jsonb
    OR imported.source->'provenance'->0->>'origin'<>'split'
    THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_IMPORT_APPLIED_OR_SOURCE_LOST'; END IF;
  IF (SELECT count(*) FROM catalog_imports WHERE staff_telegram_id=9100000028001)<>1
    OR (SELECT count(*) FROM document_intakes)<>1
    OR (SELECT original FROM document_intakes WHERE id=d.document_id)
      IS DISTINCT FROM convert_to('Offline document upgrade fixture','UTF8')
    THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_ORIGINAL_OR_COUNT'; END IF;
  IF (SELECT count(*) FROM staff_enrollment_results WHERE actor=9100000028001)<>1
    OR NOT EXISTS(SELECT 1 FROM staff WHERE telegram_id=9100000028004 AND role='seller' AND active AND NOT elevated)
    THEN RAISE EXCEPTION 'REHEARSAL_SELLER_ENROLLMENT'; END IF;
END $result$;
CREATE TEMP TABLE model_upgrade_probe(ordinal integer,document_id uuid,review_id uuid,import_id uuid);
GRANT SELECT,INSERT ON model_upgrade_probe TO service_role;
DO $fixture_guard$ BEGIN
 IF EXISTS(SELECT 1 FROM products WHERE lower(btrim(sku))='offline-model-0031') THEN
  RAISE EXCEPTION 'REHEARSAL_MODEL_FIXTURE_COLLISION'; END IF;
END $fixture_guard$;
SET LOCAL ROLE service_role;
DO $models$
DECLARE actor bigint:=9100000028001; n integer; name text; answer text; d jsonb; claim jsonb;
 r jsonb; m jsonb; b jsonb; compared jsonb; result jsonb; rid uuid; bid uuid; pid uuid; rev integer;
BEGIN
 FOR n IN 1..2 LOOP
  name:=CASE WHEN n=1 THEN 'MODEL-220' ELSE 'MODEL-380' END;
  d:=bot_document_intake(actor,'upload',NULL,jsonb_build_object('file_name','offline-model-'||n||'.tsv',
    'base64',encode(convert_to('Offline model fixture '||n,'UTF8'),'base64')));
  claim:=document_worker('claim');
  IF claim->>'id' IS DISTINCT FROM d->>'id' THEN RAISE EXCEPTION 'REHEARSAL_MODEL_CLAIM'; END IF;
  PERFORM document_worker('finish',(d->>'id')::uuid,(claim->>'lease')::uuid,
    jsonb_build_object('version','document-v1','sha256',d->>'checksum',
     'tables','[{"label":"Model comparison","header":["sku","title","price"],
       "rows":[["OFFLINE-MODEL-0031","Offline model fixture","10"]],
       "row_locators":["sheet:1/row:2"]}]'::jsonb,
     'blocks','[]'::jsonb,'warnings','[]'::jsonb,'coverage','{"complete":true}'::jsonb));
  r:=bot_document_review(actor,'open',(d->>'id')::uuid);rid:=(r->>'id')::uuid;
  r:=bot_document_review(actor,'approve',rid,(r->>'revision')::integer,0);
  BEGIN
   PERFORM bot_document_model(9100000028003,'get',rid);
   RAISE EXCEPTION 'REHEARSAL_MODEL_SELLER_ACCESS';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_MODEL_DENIED' THEN RAISE; END IF; END;
  BEGIN
   PERFORM bot_document_model(9100000028002,'get',rid);
   RAISE EXCEPTION 'REHEARSAL_MODEL_OTHER_OWNER';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'DOCUMENT_NOT_FOUND' THEN RAISE; END IF; END;
  m:=bot_document_model(actor,'get',rid);
  m:=bot_document_model(actor,'start',rid,(m->>'revision')::integer);
  FOREACH answer IN ARRAY ARRAY['Offline manufacturer',name] LOOP
   PERFORM bot_document_model(actor,'bind',rid,(m->>'revision')::integer,0,'{"message_id":931}');
   m:=bot_document_model(actor,'reply',rid,(m->>'revision')::integer,0,
     jsonb_build_object('reply_to',931,'value',answer));
  END LOOP;
  m:=bot_document_model(actor,'novar',rid,(m->>'revision')::integer);
  rev:=(m->>'revision')::integer;
  m:=bot_document_model(actor,'confirm',rid,rev);
  result:=bot_document_model(actor,'confirm',rid,rev);
  IF NOT (m->>'usable')::boolean OR result->>'revision' IS DISTINCT FROM m->>'revision'
   THEN RAISE EXCEPTION 'REHEARSAL_MODEL_CONFIRM_RECEIPT'; END IF;
  result:=bot_document_review(actor,'handoff',rid,(r->>'revision')::integer);
  bid:=(result->>'import_id')::uuid;
  INSERT INTO model_upgrade_probe VALUES(n,(d->>'id')::uuid,rid,bid);
  b:=bot_catalog_import(actor,'get',bid);
  b:=bot_catalog_import(actor,'preview',bid,
   '{"rows":[{"line":2,"sku":"OFFLINE-MODEL-0031","values":{"title":"Offline model fixture","price":10},"errors":[]}]}',
   0,(b->>'revision')::integer);
  IF b->'items'->0->'document_model'->'identity'->>'model' IS DISTINCT FROM name
   THEN RAISE EXCEPTION 'REHEARSAL_MODEL_SOURCE_LINK'; END IF;
  IF n=1 THEN
   PERFORM bot_document_model(actor,'uncertain',rid,(m->>'revision')::integer);
   BEGIN
    PERFORM bot_catalog_import(actor,'apply',bid,'{}',0,(b->>'revision')::integer);
    RAISE EXCEPTION 'REHEARSAL_MODEL_STALE_ACCEPTED';
   EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'IMPORT_MODEL_CHANGED' THEN RAISE; END IF; END;
   m:=bot_document_model(actor,'get',rid);
   PERFORM bot_document_model(actor,'confirm',rid,(m->>'revision')::integer);
   b:=bot_catalog_import(actor,'preview',bid,
    '{"rows":[{"line":2,"sku":"OFFLINE-MODEL-0031","values":{"title":"Offline model fixture","price":10},"errors":[]}]}',
    0,(b->>'revision')::integer);
  ELSE
   IF b->>'model_blocked'<>'1' THEN RAISE EXCEPTION 'REHEARSAL_MODEL_CONFLICT_NOT_VISIBLE'; END IF;
   BEGIN
    PERFORM bot_catalog_import(actor,'apply',bid,'{}',0,(b->>'revision')::integer);
    RAISE EXCEPTION 'REHEARSAL_MODEL_CONFLICT_ACCEPTED';
   EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'IMPORT_MODEL_CONFLICT' THEN RAISE; END IF; END;
   compared:=bot_catalog_import(actor,'model_compare',bid,'{"line":2}',0,(b->>'revision')::integer);
   IF compared->'model_comparison'->'incoming'->>'model'<>'MODEL-380'
    OR compared->'model_comparison'->'previous'->0->>'model'<>'MODEL-220'
    THEN RAISE EXCEPTION 'REHEARSAL_MODEL_COMPARISON'; END IF;
   result:=bot_catalog_import(actor,'model_accept',bid,'{"line":2}',0,(b->>'revision')::integer);
   PERFORM bot_catalog_import(actor,'model_accept',bid,'{"line":2}',0,(b->>'revision')::integer);
   IF result->>'state'<>'preview' OR result->>'model_blocked'<>'0'
    THEN RAISE EXCEPTION 'REHEARSAL_MODEL_DECISION_APPLIED_PRODUCT'; END IF;
  END IF;
  b:=bot_catalog_import(actor,'apply',bid,'{}',0,(b->>'revision')::integer);
  result:=bot_catalog_import(actor,'apply',bid,'{}',0,(b->>'revision')::integer);
  IF b->>'state'<>'applied' OR result->>'state'<>'applied'
   THEN RAISE EXCEPTION 'REHEARSAL_MODEL_APPLY_RECEIPT'; END IF;
  pid:=(b->'items'->0->'document_model'->>'product_id')::uuid;
  result:=bot_product_document_models(actor,pid);
  IF (result->>'conflicting')::boolean IS DISTINCT FROM (n=2)
   THEN RAISE EXCEPTION 'REHEARSAL_MODEL_HISTORY'; END IF;
 END LOOP;
 FOR bid IN SELECT import_id FROM model_upgrade_probe ORDER BY ordinal DESC LOOP
  PERFORM bot_catalog_import(actor,'undo_preview',bid);
  result:=bot_catalog_import(actor,'undo',bid);
  IF result->>'state'<>'undone' THEN RAISE EXCEPTION 'REHEARSAL_MODEL_UNDO'; END IF;
 END LOOP;
END $models$;
RESET ROLE;
DO $model_results$
BEGIN
 IF (SELECT count(*) FROM document_import_model_resolutions)<>1
  OR (SELECT count(*) FROM staff_audit_log WHERE action='catalog_import_model_resolution' AND telegram_id=9100000028001)<>1
  OR (SELECT count(*) FROM document_import_model_links WHERE product_id IS NOT NULL)<>2
  OR NOT EXISTS(SELECT 1 FROM products WHERE sku='OFFLINE-MODEL-0031' AND status='hidden' AND assortment_decision='excluded')
  THEN RAISE EXCEPTION 'REHEARSAL_MODEL_RECEIPTS_OR_EXCLUSION'; END IF;
 IF EXISTS(SELECT 1 FROM model_upgrade_probe q JOIN document_intakes d ON d.id=q.document_id
   WHERE encode(sha256(d.original),'hex')<>d.checksum)
  THEN RAISE EXCEPTION 'REHEARSAL_MODEL_ORIGINAL_CHANGED'; END IF;
END $model_results$;
SELECT jsonb_build_object('modelConfirmation',true,'modelSourceLinks',true,'modelConflictBlocked',true,
  'modelExplicitDecisionReceipt',true,'modelUndoKeepsHistory',true,'privateOriginals',true,'ownerAndSellerChecks',true,'workerLease',true,
  'humanDecisionsRequired',true,'headerPreviewAndReceipt',true,'manualRowAndUndo',true,
  'splitStableRowsAndReceipt',true,'boundReply',true,'oneUnappliedImport',true,
  'sellerEnrollmentReceipt',true,'fixturesRolledBack',true);
ROLLBACK;
