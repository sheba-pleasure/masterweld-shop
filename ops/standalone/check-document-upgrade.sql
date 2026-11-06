-- ONLY disposable offline upgrade/restore copies. No transport or live database writes.
-- The callers verify table fingerprints before/after this fully rolled-back probe.
BEGIN;
DO $guard$
DECLARE t text; role_name text; populated boolean; signature text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_intakes','document_import_links','staff_enrollment_results',
    'document_reviews','document_review_rows','document_review_prompts',
    'document_import_origins','document_structure_changes'] LOOP
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
    'public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb)'] LOOP
    IF NOT has_function_privilege('service_role',signature,'EXECUTE')
      OR has_function_privilege('anon',signature,'EXECUTE')
      OR has_function_privilege('authenticated',signature,'EXECUTE')
      THEN RAISE EXCEPTION 'REHEARSAL_DOCUMENT_RPC_ACL'; END IF;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'mw_private.bot_document_intake(bigint,text,uuid,jsonb)',
    'mw_private.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)',
    'mw_private.document_structure(bigint,text,uuid,integer,integer,integer,jsonb)',
    'public.document_review_exclusive()'] LOOP
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
SELECT jsonb_build_object('privateOriginals',true,'ownerAndSellerChecks',true,'workerLease',true,
  'humanDecisionsRequired',true,'headerPreviewAndReceipt',true,'manualRowAndUndo',true,
  'splitStableRowsAndReceipt',true,'boundReply',true,'oneUnappliedImport',true,
  'sellerEnrollmentReceipt',true,'fixturesRolledBack',true);
ROLLBACK;
