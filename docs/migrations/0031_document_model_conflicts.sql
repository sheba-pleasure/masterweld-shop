-- Compare model evidence before importing a document. This never selects a canonical model.
CREATE TABLE public.document_import_model_comparisons (
 batch_id uuid NOT NULL, line integer NOT NULL, revision integer NOT NULL,
 fingerprint text NOT NULL, evidence jsonb NOT NULL, conflict boolean NOT NULL,
 PRIMARY KEY(batch_id,line),
 FOREIGN KEY(batch_id,line) REFERENCES public.catalog_import_items(batch_id,line) ON DELETE CASCADE
);
CREATE TABLE public.document_import_model_resolutions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 batch_id uuid NOT NULL REFERENCES public.catalog_imports(id),
 line integer NOT NULL, revision integer NOT NULL, actor bigint NOT NULL,
 fingerprint text NOT NULL, incoming jsonb NOT NULL, evidence jsonb NOT NULL,
 decision text NOT NULL CHECK(decision='same_product'), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,line,revision,fingerprint)
);
ALTER TABLE public.document_import_model_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_import_model_resolutions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_import_model_comparisons,public.document_import_model_resolutions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION mw_private.document_model_evidence(p_product uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object(
  'product', (SELECT mw_private.document_product_identity(p) FROM products p WHERE id=p_product),
  'sources',coalesce((SELECT jsonb_agg(jsonb_build_object('batch',q.batch_id,'line',q.line,'identity',q.identity)
    ORDER BY q.batch_id,q.line)
    FROM document_import_model_links q JOIN catalog_imports b ON b.id=q.batch_id
    WHERE q.product_id=p_product AND q.identity IS NOT NULL AND b.state IN('applied','undo_preview')),'[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION mw_private.document_model_evidence(uuid) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) RENAME TO bot_catalog_import_models;
ALTER FUNCTION public.bot_catalog_import_models(bigint,text,uuid,jsonb,integer,integer) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_catalog_import_models(bigint,text,uuid,jsonb,integer,integer) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_catalog_import(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
 p_payload jsonb DEFAULT '{}',p_page integer DEFAULT 0,p_revision integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b catalog_imports%ROWTYPE; i catalog_import_items%ROWTYPE;
 c document_import_model_comparisons%ROWTYPE; l document_import_model_links%ROWTYPE;
 rid uuid; result jsonb; evidence jsonb; v_fingerprint text; conflict boolean; accepted boolean;
 entry jsonb; entries jsonb:='[]'; models jsonb; cmp jsonb; line_no integer; pg integer; pages integer;
 blocked integer:=0; first_line integer; required boolean;
BEGIN
 -- All imports/undo serialize their evidence checks and link writes. Model edits never erase prior evidence.
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_DENIED'; END IF;
 -- Handoff already holds this staff lock; keep the same lock order for every entry point.
 PERFORM pg_advisory_xact_lock(14757,31);
 IF p_id IS NOT NULL THEN
  SELECT * INTO b FROM catalog_imports WHERE id=p_id AND staff_telegram_id=p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_NOT_FOUND'; END IF;
  SELECT review_id INTO rid FROM document_import_origins WHERE import_id=p_id;
 END IF;
 IF p_op IN('model_compare','model_accept') THEN
  IF rid IS NULL OR b.state<>'preview' THEN RAISE EXCEPTION 'IMPORT_CLOSED'; END IF;
  IF p_revision IS DISTINCT FROM b.revision THEN RAISE EXCEPTION 'IMPORT_STALE'; END IF;
  IF b.expires_at<now() THEN RAISE EXCEPTION 'IMPORT_EXPIRED'; END IF;
  IF coalesce(p_payload->>'line','') !~ '^[0-9]{1,4}$' OR p_page IS NULL OR p_page NOT BETWEEN 0 AND 9999
  THEN RAISE EXCEPTION 'IMPORT_BAD_INPUT'; END IF;
  line_no:=(p_payload->>'line')::integer;
  SELECT * INTO c FROM document_import_model_comparisons WHERE batch_id=b.id AND line=line_no;
  IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_MODEL_COMPARISON_REQUIRED'; END IF;
  SELECT * INTO i FROM catalog_import_items WHERE batch_id=b.id AND line=line_no;
  SELECT * INTO l FROM document_import_model_links WHERE batch_id=b.id AND line=line_no;
  evidence:=mw_private.document_model_evidence(i.product_id);
  v_fingerprint:=encode(sha256(convert_to(evidence::text,'UTF8')),'hex');
  IF c.revision<>b.revision OR c.fingerprint<>v_fingerprint THEN RAISE EXCEPTION 'IMPORT_MODEL_EVIDENCE_CHANGED'; END IF;
  IF p_op='model_accept' THEN
   IF NOT c.conflict OR l.identity IS NULL THEN RAISE EXCEPTION 'IMPORT_MODEL_IDENTITY_REQUIRED'; END IF;
   -- A source/model edit must be previewed before accepting a conflict.
   cmp:=public.bot_document_model(p_actor,'get',l.review_id,NULL,l.row_index);
   IF (cmp->>'revision')::integer<>l.model_revision OR NOT (cmp->>'usable')::boolean
   THEN RAISE EXCEPTION 'IMPORT_MODEL_CHANGED'; END IF;
   INSERT INTO document_import_model_resolutions(batch_id,line,revision,actor,fingerprint,incoming,evidence,decision)
    VALUES(b.id,line_no,b.revision,p_actor,v_fingerprint,l.identity,evidence,'same_product')
    ON CONFLICT(batch_id,line,revision,fingerprint) DO NOTHING;
   IF FOUND THEN
    INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'catalog_import_model_resolution',
     jsonb_build_object('batch_id',b.id,'line',line_no,'revision',b.revision,'decision','same_product'));
   END IF;
  ELSE
   SELECT coalesce(jsonb_agg(identity ORDER BY identity::text),'[]') INTO models
    FROM (SELECT DISTINCT s->'identity' identity FROM jsonb_array_elements(evidence->'sources') s) x;
   pages:=greatest(1,ceil(jsonb_array_length(models)/3.0)::integer);pg:=least(p_page,pages-1);
   SELECT coalesce(jsonb_agg(value ORDER BY ord),'[]') INTO models
    FROM jsonb_array_elements(models) WITH ORDINALITY x(value,ord) WHERE ord>pg*3 AND ord<=pg*3+3;
   SELECT EXISTS(SELECT 1 FROM document_import_model_resolutions WHERE batch_id=b.id AND line=line_no
    AND revision=b.revision AND actor=p_actor AND fingerprint=c.fingerprint) INTO accepted;
   cmp:=jsonb_build_object('line',line_no,'sku',i.sku,'incoming',l.identity,'previous',models,
    'page',pg,'pages',pages,'conflict',c.conflict,'accepted',accepted,'review_id',l.review_id,'row',l.row_index);
  END IF;
 END IF;
 IF p_op='apply' AND rid IS NOT NULL AND b.state='preview' THEN
  IF p_revision IS DISTINCT FROM b.revision THEN RAISE EXCEPTION 'IMPORT_STALE'; END IF;
  FOR i IN SELECT * FROM catalog_import_items WHERE batch_id=b.id ORDER BY line LOOP
   SELECT * INTO c FROM document_import_model_comparisons WHERE batch_id=b.id AND line=i.line;
   IF NOT FOUND OR c.revision<>b.revision THEN RAISE EXCEPTION 'IMPORT_MODEL_COMPARISON_REQUIRED'; END IF;
   evidence:=mw_private.document_model_evidence(i.product_id);
   IF c.fingerprint<>encode(sha256(convert_to(evidence::text,'UTF8')),'hex')
   THEN RAISE EXCEPTION 'IMPORT_MODEL_EVIDENCE_CHANGED'; END IF;
   IF c.conflict AND NOT EXISTS(SELECT 1 FROM document_import_model_resolutions WHERE batch_id=b.id
    AND line=i.line AND revision=b.revision AND actor=p_actor AND fingerprint=c.fingerprint)
   THEN RAISE EXCEPTION 'IMPORT_MODEL_CONFLICT'; END IF;
  END LOOP;
 END IF;
 result:=mw_private.bot_catalog_import_models(p_actor,
  CASE WHEN p_op IN('model_compare','model_accept') THEN 'get' ELSE p_op END,p_id,p_payload,p_page,p_revision);
 IF p_op='preview' AND rid IS NOT NULL THEN
  SELECT * INTO b FROM catalog_imports WHERE id=p_id;
  FOR i IN SELECT * FROM catalog_import_items WHERE batch_id=b.id ORDER BY line LOOP
   SELECT * INTO l FROM document_import_model_links WHERE batch_id=b.id AND line=i.line;
   evidence:=mw_private.document_model_evidence(i.product_id);
   conflict:=EXISTS(SELECT 1 FROM jsonb_array_elements(evidence->'sources') s WHERE s->'identity' IS DISTINCT FROM l.identity);
   INSERT INTO document_import_model_comparisons(batch_id,line,revision,fingerprint,evidence,conflict)
    VALUES(b.id,i.line,b.revision,encode(sha256(convert_to(evidence::text,'UTF8')),'hex'),evidence,conflict);
  END LOOP;
 END IF;
 IF rid IS NOT NULL AND result->>'state'='preview' THEN
  -- Read-time flags are guidance; apply repeats the checks transactionally.
  FOR i IN SELECT * FROM catalog_import_items WHERE batch_id=p_id ORDER BY line LOOP
   SELECT * INTO c FROM document_import_model_comparisons WHERE batch_id=p_id AND line=i.line;
   required:=NOT FOUND;
   IF NOT required THEN
    evidence:=mw_private.document_model_evidence(i.product_id);
    required:=c.revision<>(result->>'revision')::integer
     OR c.fingerprint<>encode(sha256(convert_to(evidence::text,'UTF8')),'hex')
     OR (c.conflict AND NOT EXISTS(SELECT 1 FROM document_import_model_resolutions WHERE batch_id=p_id
       AND line=i.line AND revision=c.revision AND actor=p_actor AND fingerprint=c.fingerprint));
   END IF;
   IF required THEN blocked:=blocked+1;first_line:=coalesce(first_line,i.line); END IF;
  END LOOP;
  FOR entry IN SELECT * FROM jsonb_array_elements(result->'items') LOOP
   SELECT * INTO c FROM document_import_model_comparisons WHERE batch_id=p_id AND line=(entry->>'line')::integer;
   accepted:=EXISTS(SELECT 1 FROM document_import_model_resolutions WHERE batch_id=p_id AND line=c.line
    AND revision=c.revision AND actor=p_actor AND fingerprint=c.fingerprint);
   entries:=entries||jsonb_build_array(entry||jsonb_build_object('model_conflict',coalesce(c.conflict,false),'model_conflict_accepted',accepted));
  END LOOP;
  result:=result||jsonb_build_object('items',entries,'model_blocked',blocked,'model_first_blocked',first_line);
 END IF;
 IF p_op='model_compare' THEN result:=result||jsonb_build_object('model_comparison',cmp); END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) TO service_role;
NOTIFY pgrst,'reload schema';
