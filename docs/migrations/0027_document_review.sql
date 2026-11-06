-- Human decisions are derivatives. Never rewrite the original bytes or extraction.
CREATE TABLE public.document_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 document_id uuid NOT NULL REFERENCES public.document_intakes(id),
 table_index integer NOT NULL CHECK(table_index BETWEEN 0 AND 999),
 revision integer NOT NULL DEFAULT 0,
 handed_import_id uuid REFERENCES public.catalog_imports(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,table_index)
);
CREATE TABLE public.document_review_rows (
 review_id uuid NOT NULL REFERENCES public.document_reviews(id),
 row_index integer NOT NULL CHECK(row_index BETWEEN 0 AND 4999),
 cells jsonb NOT NULL CHECK(jsonb_typeof(cells)='array'),
 decision text NOT NULL DEFAULT 'pending' CHECK(decision IN('pending','approved','excluded')),
 decided_by bigint, decided_at timestamptz,
 PRIMARY KEY(review_id,row_index)
);
CREATE TABLE public.document_review_prompts (
 actor bigint PRIMARY KEY REFERENCES public.staff(telegram_id),
 review_id uuid NOT NULL REFERENCES public.document_reviews(id),
 revision integer NOT NULL,
 row_index integer NOT NULL,
 column_index integer NOT NULL,
 message_id bigint,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
-- Keep legacy unreviewed imports blocked even after the document gets a reviewed successor.
CREATE TABLE public.document_import_origins (
 import_id uuid PRIMARY KEY REFERENCES public.catalog_imports(id),
 review_id uuid REFERENCES public.document_reviews(id)
);
INSERT INTO public.document_import_origins(import_id) SELECT import_id FROM public.document_import_links;
ALTER TABLE public.document_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_review_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_review_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_import_origins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_reviews,public.document_review_rows,public.document_review_prompts,
 public.document_import_origins FROM PUBLIC,anon,authenticated,service_role;

-- A correction question and another product editor must never compete for one answer.
CREATE FUNCTION public.document_review_exclusive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor_id bigint;
BEGIN
 IF TG_TABLE_NAME='document_review_prompts' THEN
   IF NEW.expires_at<=now() THEN RETURN NEW; END IF;
   actor_id:=NEW.actor;
 ELSIF TG_TABLE_NAME='bot_editor_states' THEN
   IF NEW.consumed_at IS NOT NULL OR NEW.expires_at<=now() THEN RETURN NEW; END IF;
   actor_id:=NEW.staff_telegram_id;
 ELSE
   IF NEW.phase NOT IN('editing','preview') OR NEW.expires_at<=now() THEN RETURN NEW; END IF;
   actor_id:=NEW.staff_telegram_id;
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'EDITOR_ISOLATION_REQUIRED'; END IF;
 PERFORM 1 FROM staff WHERE telegram_id=actor_id FOR UPDATE;
 IF TG_TABLE_NAME='document_review_prompts' THEN
   IF EXISTS(SELECT 1 FROM bot_editor_states WHERE staff_telegram_id=actor_id AND consumed_at IS NULL AND expires_at>now())
     OR EXISTS(SELECT 1 FROM technical_editor_sessions WHERE staff_telegram_id=actor_id AND phase IN('editing','preview') AND expires_at>now())
   THEN RAISE EXCEPTION 'DOCUMENT_OTHER_INPUT'; END IF;
 ELSE
   IF EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=actor_id AND expires_at>now())
   THEN RAISE EXCEPTION 'DOCUMENT_INPUT_ACTIVE'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.document_review_exclusive() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER document_review_exclusive_guard BEFORE INSERT OR UPDATE ON public.document_review_prompts
 FOR EACH ROW EXECUTE FUNCTION public.document_review_exclusive();
CREATE TRIGGER document_review_ordinary_guard BEFORE INSERT OR UPDATE ON public.bot_editor_states
 FOR EACH ROW EXECUTE FUNCTION public.document_review_exclusive();
CREATE TRIGGER document_review_technical_guard BEFORE INSERT OR UPDATE ON public.technical_editor_sessions
 FOR EACH ROW EXECUTE FUNCTION public.document_review_exclusive();

-- Keep the previous catalog implementation private; guard all old and new entry points.
ALTER FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.bot_catalog_import(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
 p_payload jsonb DEFAULT '{}',p_page integer DEFAULT 0,p_revision integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active AND(role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'IMPORT_DENIED'; END IF;
 IF p_op IN('preview','apply') AND EXISTS(SELECT 1 FROM document_import_origins
   WHERE import_id=p_id AND review_id IS NULL) THEN RAISE EXCEPTION 'DOCUMENT_REVIEW_REQUIRED'; END IF;
 RETURN mw_private.bot_catalog_import(p_actor,p_op,p_id,p_payload,p_page,p_revision);
END $$;
REVOKE ALL ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_catalog_import(bigint,text,uuid,jsonb,integer,integer) TO service_role;

ALTER FUNCTION public.bot_document_intake(bigint,text,uuid,jsonb) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_document_intake(bigint,text,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.bot_document_intake(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_op='table' THEN RAISE EXCEPTION 'DOCUMENT_REVIEW_REQUIRED'; END IF;
 RETURN mw_private.bot_document_intake(p_actor,p_op,p_id,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.bot_document_intake(bigint,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_document_intake(bigint,text,uuid,jsonb) TO service_role;

CREATE FUNCTION public.bot_document_review(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
 p_revision integer DEFAULT NULL,p_row integer DEFAULT 0,p_column integer DEFAULT NULL,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s staff%ROWTYPE; d document_intakes%ROWTYPE; r document_reviews%ROWTYPE;
 v document_review_rows%ROWTYPE; prompt document_review_prompts%ROWTYPE;
 t jsonb; counts jsonb; result jsonb; src jsonb; mapping jsonb; col text;
 idx integer; target integer; v_request_key text; linked uuid; changed boolean:=false;
BEGIN
 SELECT * INTO s FROM staff WHERE telegram_id=p_actor FOR UPDATE;
 IF NOT FOUND OR NOT s.active OR NOT(s.role::text='admin' OR(s.role::text='director' AND s.elevated))
 THEN RAISE EXCEPTION 'DOCUMENT_DENIED'; END IF;
 IF p_op='input' THEN
   SELECT * INTO prompt FROM document_review_prompts WHERE actor=p_actor;
   IF NOT FOUND OR prompt.expires_at<=now() THEN RETURN jsonb_build_object('ok',true,'idle',true); END IF;
   RETURN jsonb_build_object('ok',true,'prompt',to_jsonb(prompt));
 END IF;
 IF p_op='open' THEN
   SELECT * INTO d FROM document_intakes WHERE id=p_id AND staff_telegram_id=p_actor FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND'; END IF;
   t:=d.extraction->'tables'->p_row;
   IF d.state<>'review' OR p_row IS NULL OR p_row NOT BETWEEN 0 AND 999 OR t IS NULL
     OR jsonb_typeof(t->'header') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'header') NOT BETWEEN 2 AND 30
     OR jsonb_typeof(t->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(t->'rows') NOT BETWEEN 1 AND 5000
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'header') x WHERE jsonb_typeof(x)<>'string' OR length(x#>>'{}')>100)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(t->'rows') x WHERE jsonb_typeof(x)<>'array')
   THEN RAISE EXCEPTION 'DOCUMENT_TABLE'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(t->'rows') x CROSS JOIN LATERAL jsonb_array_elements(x) c
     WHERE jsonb_typeof(c)<>'string' OR length(c#>>'{}')>2000)
   THEN RAISE EXCEPTION 'DOCUMENT_TABLE'; END IF;
   INSERT INTO document_reviews(document_id,table_index) VALUES(d.id,p_row) ON CONFLICT DO NOTHING;
   SELECT * INTO r FROM document_reviews WHERE document_id=d.id AND table_index=p_row FOR UPDATE;
   INSERT INTO document_review_rows(review_id,row_index,cells)
     SELECT r.id,ord-1,x FROM jsonb_array_elements(t->'rows') WITH ORDINALITY a(x,ord)
     ON CONFLICT DO NOTHING;
   target:=0;
 ELSE
   SELECT q.* INTO r FROM document_reviews q JOIN document_intakes a ON a.id=q.document_id
     WHERE q.id=p_id AND a.staff_telegram_id=p_actor FOR UPDATE OF q;
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND'; END IF;
   SELECT * INTO d FROM document_intakes WHERE id=r.document_id;
   t:=d.extraction->'tables'->r.table_index;
   target:=p_row;
 END IF;
 IF p_op NOT IN('open','get','next','summary','edit','bind','save','cancel','approve','exclude','pending','handoff')
 THEN RAISE EXCEPTION 'DOCUMENT_OP'; END IF;
 IF p_op='handoff' AND r.handed_import_id IS NOT NULL THEN
   RETURN jsonb_build_object('ok',true,'import_id',r.handed_import_id);
 END IF;
 IF p_op IN('edit','bind','save','cancel','approve','exclude','pending','handoff') THEN
   IF r.handed_import_id IS NOT NULL THEN RAISE EXCEPTION 'DOCUMENT_FROZEN'; END IF;
   IF p_revision IS DISTINCT FROM r.revision THEN RAISE EXCEPTION 'DOCUMENT_STALE'; END IF;
 END IF;
 SELECT * INTO v FROM document_review_rows WHERE review_id=r.id AND row_index=target;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_ROW'; END IF;
 IF p_op IN('edit','bind','save') AND
   (p_column IS NULL OR p_column<0 OR p_column>=jsonb_array_length(t->'header'))
 THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
 IF p_op='edit' THEN
   -- Opening a correction also withdraws approval, including when delivery fails or input is canceled.
   UPDATE document_review_rows SET decision='pending',decided_by=NULL,decided_at=NULL WHERE review_id=r.id AND row_index=target;
   INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_review_edit',
     jsonb_build_object('review_id',r.id,'row',target,'column',p_column,'revision',r.revision+1));
   -- A new question invalidates previous callbacks/answers, even for the same cell.
   UPDATE document_reviews SET revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   INSERT INTO document_review_prompts(actor,review_id,revision,row_index,column_index)
     VALUES(p_actor,r.id,r.revision,target,p_column)
     ON CONFLICT(actor) DO UPDATE SET review_id=excluded.review_id,revision=excluded.revision,
       row_index=excluded.row_index,column_index=excluded.column_index,message_id=NULL,expires_at=now()+interval '24 hours';
 ELSIF p_op='bind' THEN
   IF coalesce(p_payload->>'message_id','') !~ '^[1-9][0-9]{0,15}$' THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
   UPDATE document_review_prompts SET message_id=(p_payload->>'message_id')::bigint
    WHERE actor=p_actor AND review_id=r.id AND revision=r.revision AND row_index=target
      AND column_index=p_column AND message_id IS NULL AND expires_at>now();
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
 ELSIF p_op='save' THEN
   SELECT * INTO prompt FROM document_review_prompts WHERE actor=p_actor;
   IF NOT FOUND OR prompt.review_id<>r.id OR prompt.revision<>r.revision OR prompt.row_index<>target
     OR prompt.column_index<>p_column OR prompt.message_id IS NULL OR prompt.expires_at<=now()
     OR p_payload->>'reply_to' IS DISTINCT FROM prompt.message_id::text
   THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
   IF jsonb_typeof(p_payload->'value') IS DISTINCT FROM 'string' OR length(p_payload->>'value')>2000
   THEN RAISE EXCEPTION 'DOCUMENT_VALUE'; END IF;
   -- Preserve other cells, padding missing cells without dropping extra OCR columns.
   WHILE jsonb_array_length(v.cells)<=p_column LOOP v.cells:=v.cells||'[""]'::jsonb; END LOOP;
   UPDATE document_review_rows SET cells=jsonb_set(v.cells,ARRAY[p_column::text],p_payload->'value'),
     decision='pending',decided_by=NULL,decided_at=NULL WHERE review_id=r.id AND row_index=target;
   changed:=true;
 ELSIF p_op IN('approve','exclude','pending') THEN
   IF p_op='approve' AND (jsonb_array_length(v.cells)<>jsonb_array_length(t->'header')
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v.cells) c WHERE btrim(c)<>''))
   THEN RAISE EXCEPTION 'DOCUMENT_ROW_WIDTH'; END IF;
   UPDATE document_review_rows SET decision=CASE p_op WHEN 'approve' THEN 'approved' WHEN 'exclude' THEN 'excluded' ELSE 'pending' END,
    decided_by=CASE WHEN p_op='pending' THEN NULL ELSE p_actor END,
    decided_at=CASE WHEN p_op='pending' THEN NULL ELSE now() END
    WHERE review_id=r.id AND row_index=target;
   changed:=true;
 ELSIF p_op='cancel' THEN
   changed:=true;
 ELSIF p_op='handoff' THEN
   IF EXISTS(SELECT 1 FROM document_review_rows WHERE review_id=r.id AND decision='pending')
     OR NOT EXISTS(SELECT 1 FROM document_review_rows WHERE review_id=r.id AND decision='approved')
   THEN RAISE EXCEPTION 'DOCUMENT_UNREVIEWED'; END IF;
   SELECT import_id INTO linked FROM document_import_links WHERE document_id=d.id AND table_index=r.table_index;
   IF linked IS NOT NULL AND EXISTS(SELECT 1 FROM catalog_imports WHERE id=linked AND state<>'canceled')
   THEN RAISE EXCEPTION 'DOCUMENT_LEGACY_IMPORT'; END IF;
   SELECT jsonb_build_object('header',t->'header','rows',jsonb_agg(cells ORDER BY row_index),
      'provenance',jsonb_agg(jsonb_build_object('source_row',row_index,'locator',t->'row_locators'->row_index) ORDER BY row_index),
      'document_id',d.id,'original_sha256',d.checksum,'review_id',r.id,'review_revision',r.revision)
     INTO src FROM document_review_rows WHERE review_id=r.id AND decision='approved';
   mapping:='{"sku":-1,"title":-1,"brand":-1,"price":-1,"cost_price":-1,"in_stock":-1,"stock_qty":-1,"category_slug":-1}';
   idx:=0;
   FOR col IN SELECT jsonb_array_elements_text(t->'header') LOOP
     IF mapping ? col AND (SELECT count(*) FROM jsonb_array_elements_text(t->'header') x WHERE x=col)=1
     THEN mapping:=jsonb_set(mapping,ARRAY[col],to_jsonb(idx)); END IF;
     idx:=idx+1;
   END LOOP;
   LOOP
     v_request_key:=nextval('mw_private.document_import_request')::text;
     EXIT WHEN NOT EXISTS(SELECT 1 FROM catalog_imports c WHERE c.staff_telegram_id=p_actor AND c.request_key=v_request_key);
   END LOOP;
   result:=public.bot_catalog_import(p_actor,'upload',NULL,jsonb_build_object('request_key',v_request_key,
     'checksum',encode(sha256(convert_to(src::text,'UTF8')),'hex'),
     'file_name',left(d.file_name||' · проверено',200),'source',src,'mapping',mapping),0,NULL);
   linked:=(result->>'id')::uuid;
   INSERT INTO document_import_origins VALUES(linked,r.id);
   INSERT INTO document_import_links VALUES(d.id,r.table_index,linked)
     ON CONFLICT(document_id,table_index) DO UPDATE SET import_id=excluded.import_id;
   UPDATE document_reviews SET handed_import_id=linked,revision=revision+1 WHERE id=r.id;
   DELETE FROM document_review_prompts WHERE review_id=r.id;
   INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_review_handoff',
     jsonb_build_object('review_id',r.id,'revision',r.revision,'import_id',linked,'original_sha256',d.checksum));
   RETURN jsonb_build_object('ok',true,'import_id',linked);
 END IF;
 IF changed THEN
   UPDATE document_reviews SET revision=revision+1 WHERE id=r.id RETURNING * INTO r;
   DELETE FROM document_review_prompts WHERE actor=p_actor AND review_id=r.id;
   INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_review_'||p_op,
     jsonb_build_object('review_id',r.id,'revision',r.revision,'row',target,'column',p_column));
 END IF;
 SELECT jsonb_build_object('pending',count(*) FILTER(WHERE decision='pending'),
   'approved',count(*) FILTER(WHERE decision='approved'),'excluded',count(*) FILTER(WHERE decision='excluded'),
   'total',count(*)) INTO counts FROM document_review_rows WHERE review_id=r.id;
 IF p_op IN('next','approve','exclude') THEN
   SELECT row_index INTO idx FROM document_review_rows WHERE review_id=r.id AND decision='pending'
     ORDER BY CASE WHEN row_index>target THEN 0 ELSE 1 END,row_index LIMIT 1;
   target:=coalesce(idx,target);
 END IF;
 SELECT * INTO v FROM document_review_rows WHERE review_id=r.id AND row_index=target;
 SELECT import_id INTO linked FROM document_import_links WHERE document_id=d.id AND table_index=r.table_index;
 RETURN jsonb_build_object('ok',true,'id',r.id,'document_id',d.id,'revision',r.revision,
   'file_name',d.file_name,'table_label',t->>'label','header',t->'header',
   'row',target,'cells',v.cells,'original',t->'rows'->target,'locator',t->'row_locators'->target,
   'decision',v.decision,'counts',counts,'import_id',r.handed_import_id,
   'legacy_import_id',CASE WHEN r.handed_import_id IS NULL THEN linked ELSE NULL END,
   'warnings',coalesce(t->'warnings','[]')||coalesce(d.extraction->'warnings','[]'),
   'coverage',d.extraction->'coverage');
END $$;
REVOKE ALL ON FUNCTION public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
