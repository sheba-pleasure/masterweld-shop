-- Only synthetic production-schema.py resources; no real users or transport.
BEGIN;
INSERT INTO staff(telegram_id,name,role,active,elevated)
 VALUES(7000000000000043,'[Учебный] Isolated production fixture','admin',true,false);
INSERT INTO products(id,slug,sku,title,price,status,assortment_decision)
 VALUES('f0000000-0000-4000-8000-000000000043','qa-private-accessory-0043','QA-PRIVATE-0043',
 '[Учебный] Вымышленная горелка только в изолированной базе',1,'hidden','excluded');
SET LOCAL ROLE service_role;
DO $flow$
DECLARE actor bigint:=7000000000000043; e jsonb; applied jsonb; doc jsonb; state jsonb;
BEGIN
 e:=bot_technical_editor(actor,'start',p_product_id=>'f0000000-0000-4000-8000-000000000043')->'session';
 doc:=jsonb_build_object('family_code','tig_torch',
  'sources',jsonb_build_array(jsonb_build_object('key','qa','kind','manual','publisher','Isolated test fixture',
   'model','QA-PRIVATE-0043','title','[Учебный] Вымышленный документ, не паспорт реального товара',
   'url','https://example.invalid/isolated-fixture','locator','Только транзакция репетиции',
   'checked_on',current_date::text,'sha256','')),
  'values','[{"attribute_code":"tig_torch_max_dc_a","process":"tig","state":"known","value":160,
     "unit_code":"a","context":{"duty_pct":60},"source_key":"qa"}]'::jsonb);
 state:=jsonb_set(e->'data','{document}',doc);
 e:=bot_technical_editor(actor,'save',(e->>'id')::uuid,(e->>'revision')::integer,p_data=>state)->'session';
 BEGIN
  PERFORM bot_technical_editor(actor,'preview',(e->>'id')::uuid,(e->>'revision')::integer,p_review_state=>'verified');
  RAISE EXCEPTION 'ACCESSORY_CONDITIONS_NOT_REQUIRED';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'TECH_CONTEXT_REQUIRED' THEN RAISE; END IF;
 END;
 doc:=jsonb_set(doc,'{values,0,context,test_conditions}',to_jsonb(E'Учебные условия.\nТолько вымышленная модель.'::text));
 state:=jsonb_set(e->'data','{document}',doc);
 e:=bot_technical_editor(actor,'save',(e->>'id')::uuid,(e->>'revision')::integer,p_data=>state)->'session';
 e:=bot_technical_editor(actor,'preview',(e->>'id')::uuid,(e->>'revision')::integer,p_review_state=>'verified')->'session';
 applied:=bot_technical_editor(actor,'apply',(e->>'id')::uuid,(e->>'revision')::integer)->'session';
 IF applied->>'phase'<>'applied' OR
  (bot_technical_editor(actor,'apply',(e->>'id')::uuid,(e->>'revision')::integer)->'session'->>'applied_revision')
   IS DISTINCT FROM applied->>'applied_revision'
 THEN RAISE EXCEPTION 'ACCESSORY_APPLY_DUPLICATED'; END IF;
 PERFORM set_config('mw.qa_accessory_revision',applied->>'applied_revision',true);
 PERFORM set_config('mw.qa_accessory_session',applied::text,true);
END $flow$;
SET LOCAL ROLE anon;
DO $public$ BEGIN
 IF public_product_technical('f0000000-0000-4000-8000-000000000043') IS NOT NULL
 THEN RAISE EXCEPTION 'EXCLUDED_ACCESSORY_PUBLISHED'; END IF;
END $public$;
RESET ROLE;
DO $stored$ BEGIN
 IF (SELECT count(*) FROM technical_revisions WHERE product_id='f0000000-0000-4000-8000-000000000043')<>1
  OR (SELECT document#>>'{values,0,context,test_conditions}' FROM technical_revisions
     WHERE id=current_setting('mw.qa_accessory_revision')::uuid)
      IS DISTINCT FROM E'Учебные условия.\nТолько вымышленная модель.'
 THEN RAISE EXCEPTION 'ACCESSORY_STORED_FACT_CHANGED'; END IF;
END $stored$;
SET LOCAL ROLE service_role;
DO $undo$
DECLARE e jsonb:=current_setting('mw.qa_accessory_session')::jsonb;
BEGIN
 e:=bot_technical_editor(7000000000000043,'undo',(e->>'id')::uuid,(e->>'revision')::integer)->'session';
 IF e->>'phase'<>'undone' THEN RAISE EXCEPTION 'ACCESSORY_UNDO_FAILED'; END IF;
END $undo$;
RESET ROLE;
DO $state$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM products WHERE id='f0000000-0000-4000-8000-000000000043'
    AND status='hidden' AND assortment_decision='excluded')
  OR EXISTS(SELECT 1 FROM technical_cards WHERE product_id='f0000000-0000-4000-8000-000000000043'
    AND published_revision IS NOT NULL)
 THEN RAISE EXCEPTION 'ACCESSORY_UNDO_OR_EXCLUSION_CHANGED'; END IF;
END $state$;
SELECT jsonb_build_object('requiredConditions',true,'literalConditionsPreserved',true,
 'separatePreviewApply',true,'duplicateApplyOneRevision',true,'excludedNotPublished',true,
 'undoRestoredNoPublishedCard',true,'syntheticFixtureOnly',true);
ROLLBACK;
