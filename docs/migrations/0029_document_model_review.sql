-- DEV first. A model decision is a derivative of one stable document row, not a product write.
ALTER TABLE public.document_review_prompts DROP CONSTRAINT document_review_prompts_kind_check;
ALTER TABLE public.document_review_prompts ADD CONSTRAINT document_review_prompts_kind_check
 CHECK(kind IN('cell','structure','model'));

-- Older application versions must not treat a model answer as a cell correction.
ALTER FUNCTION public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb) SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.bot_document_review(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
 p_revision integer DEFAULT NULL,p_row integer DEFAULT 0,p_column integer DEFAULT NULL,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active AND
   (role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_MODEL_DENIED'; END IF;
 IF p_op NOT IN('input','get','open') AND EXISTS(SELECT 1 FROM document_review_prompts
   WHERE actor=p_actor AND kind='model' AND expires_at>now())
 THEN RAISE EXCEPTION 'DOCUMENT_MODEL_INPUT_ACTIVE'; END IF;
 RETURN mw_private.bot_document_review(p_actor,p_op,p_id,p_revision,p_row,p_column,p_payload);
END $$;
REVOKE ALL ON FUNCTION public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb) TO service_role;

CREATE TABLE public.document_model_checks (
 review_id uuid NOT NULL,
 row_index integer NOT NULL,
 revision integer NOT NULL DEFAULT 0,
 source_hash text NOT NULL,
 manufacturer text NOT NULL DEFAULT '' CHECK(length(manufacturer)<=100),
 model text NOT NULL DEFAULT '' CHECK(length(model)<=150),
 variant_mode text NOT NULL DEFAULT 'unknown' CHECK(variant_mode IN('unknown','none','specified')),
 variant text NOT NULL DEFAULT '' CHECK(length(variant)<=150),
 state text NOT NULL DEFAULT 'draft' CHECK(state IN('draft','confirmed','needs_review')),
 focus integer NOT NULL DEFAULT -1 CHECK(focus BETWEEN -1 AND 2),
 guided boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(review_id,row_index),
 FOREIGN KEY(review_id,row_index) REFERENCES public.document_review_rows(review_id,row_index)
);
CREATE TABLE public.document_model_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 review_id uuid NOT NULL,
 row_index integer NOT NULL,
 base_revision integer NOT NULL,
 actor bigint NOT NULL REFERENCES public.staff(telegram_id),
 decision text NOT NULL CHECK(decision IN('confirmed','needs_review')),
 identity jsonb NOT NULL,
 source_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(review_id,row_index) REFERENCES public.document_review_rows(review_id,row_index),
 UNIQUE(review_id,row_index,base_revision)
);
ALTER TABLE public.document_model_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_model_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_model_checks,public.document_model_decisions FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_document_model(p_actor bigint,p_op text,p_id uuid,
 p_revision integer DEFAULT NULL,p_row integer DEFAULT 0,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r document_reviews%ROWTYPE; v document_review_rows%ROWTYPE; d document_intakes%ROWTYPE;
 m document_model_checks%ROWTYPE; prompt document_review_prompts%ROWTYPE; event document_model_decisions%ROWTYPE;
 h jsonb; t jsonb; snapshot jsonb; fingerprint text; value text; field integer; missing boolean;
 notice text; current_prompt jsonb; history jsonb; eligible boolean;
BEGIN
 PERFORM 1 FROM staff WHERE telegram_id=p_actor AND active AND
   (role::text='admin' OR(role::text='director' AND elevated)) FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_MODEL_DENIED'; END IF;
 SELECT a.* INTO d FROM document_intakes a JOIN document_reviews q ON q.document_id=a.id
  WHERE q.id=p_id AND a.staff_telegram_id=p_actor;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND'; END IF;
 SELECT * INTO r FROM document_reviews WHERE id=p_id FOR UPDATE;
 SELECT * INTO v FROM document_review_rows WHERE review_id=p_id AND row_index=p_row;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_ROW_REPLACED'; END IF;
 t:=d.extraction->'tables'->r.table_index;
 h:=coalesce(r.header_override,t->'header');
 snapshot:=jsonb_build_object('document_id',d.id,'checksum',d.checksum,'table_index',r.table_index,
   'row_index',v.row_index,'header',h,'cells',v.cells,'origin',v.origin,'source_row',v.source_row,
   'source_note',v.source_note,'locator',CASE WHEN v.origin='manual' THEN NULL
     ELSE t->'row_locators'->coalesce(v.source_row,v.row_index) END);
 fingerprint:=encode(sha256(convert_to(snapshot::text,'UTF8')),'hex');
 eligible:=NOT v.retired AND v.decision='approved' AND r.structure_draft IS NULL;
 SELECT * INTO m FROM document_model_checks WHERE review_id=p_id AND row_index=p_row FOR UPDATE;
 missing:=NOT FOUND;
 SELECT * INTO prompt FROM document_review_prompts WHERE actor=p_actor;
 IF p_op NOT IN('get','start','askbrand','askmodel','askvar','resume','bind','reply','novar','uncertain','confirm','cancel')
 THEN RAISE EXCEPTION 'DOCUMENT_MODEL_OPERATION'; END IF;
 IF p_op IN('confirm','uncertain') THEN
   SELECT * INTO event FROM document_model_decisions WHERE review_id=p_id AND row_index=p_row AND base_revision=p_revision;
   IF FOUND THEN
     notice:='Это решение уже сохранено. Показано текущее состояние модели.';
     p_op:='get';
   END IF;
 END IF;
 IF p_op<>'get' THEN
   IF p_revision IS DISTINCT FROM (CASE WHEN missing THEN 0 ELSE m.revision END)
   THEN RAISE EXCEPTION 'DOCUMENT_MODEL_STALE'; END IF;
   IF p_op<>'cancel' AND NOT eligible THEN RAISE EXCEPTION 'DOCUMENT_MODEL_ROW_REVIEW'; END IF;
   IF prompt.actor IS NOT NULL AND prompt.expires_at>now() AND
     (prompt.kind<>'model' OR prompt.review_id<>p_id OR prompt.row_index<>p_row)
   THEN RAISE EXCEPTION 'DOCUMENT_INPUT_ACTIVE'; END IF;
   IF NOT missing AND m.source_hash<>fingerprint AND p_op NOT IN('start','cancel')
   THEN RAISE EXCEPTION 'DOCUMENT_MODEL_SOURCE_CHANGED'; END IF;
   IF missing THEN
     IF p_op NOT IN('start','uncertain') THEN RAISE EXCEPTION 'DOCUMENT_MODEL_MISSING'; END IF;
     INSERT INTO document_model_checks(review_id,row_index,source_hash) VALUES(p_id,p_row,fingerprint) RETURNING * INTO m;
     missing:=false;
   END IF;
   IF p_op='start' THEN
     IF m.source_hash<>fingerprint THEN
       m.manufacturer:=''; m.model:=''; m.variant_mode:='unknown'; m.variant:='';
     END IF;
     m.source_hash:=fingerprint; m.state:='draft'; m.focus:=0; m.guided:=true;
   ELSIF p_op IN('askbrand','askmodel','askvar') THEN
     m.focus:=CASE p_op WHEN 'askbrand' THEN 0 WHEN 'askmodel' THEN 1 ELSE 2 END;
     m.guided:=false; m.state:='draft';
   ELSIF p_op='resume' THEN
     IF m.focus<0 OR prompt.kind IS DISTINCT FROM 'model' OR prompt.review_id IS DISTINCT FROM p_id
       OR prompt.row_index IS DISTINCT FROM p_row OR prompt.expires_at<=now()
     THEN RAISE EXCEPTION 'DOCUMENT_MODEL_QUESTION'; END IF;
   ELSIF p_op='bind' THEN
     IF coalesce(p_payload->>'message_id','') !~ '^[1-9][0-9]{0,15}$' THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
     UPDATE document_review_prompts SET message_id=(p_payload->>'message_id')::bigint
       WHERE actor=p_actor AND kind='model' AND review_id=p_id AND row_index=p_row AND revision=m.revision
         AND message_id IS NULL AND expires_at>now();
     IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_MODEL_QUESTION'; END IF;
   ELSIF p_op='reply' THEN
     IF prompt.kind IS DISTINCT FROM 'model' OR prompt.review_id IS DISTINCT FROM p_id
       OR prompt.row_index IS DISTINCT FROM p_row OR prompt.revision IS DISTINCT FROM m.revision
       OR prompt.expires_at<=now() OR prompt.message_id IS NULL
       OR coalesce(p_payload->>'reply_to','')<>prompt.message_id::text
       OR m.focus NOT BETWEEN 0 AND 2
     THEN RAISE EXCEPTION 'DOCUMENT_MODEL_QUESTION'; END IF;
     value:=btrim(coalesce(p_payload->>'value','')); field:=m.focus;
     IF value='' OR value='—' OR length(value)>(CASE WHEN field=0 THEN 100 ELSE 150 END) OR value ~ E'[\n\r\t]'
     THEN RAISE EXCEPTION 'DOCUMENT_MODEL_VALUE'; END IF;
     IF field=0 THEN m.manufacturer:=value;
     ELSIF field=1 THEN m.model:=value;
     ELSE m.variant:=value; m.variant_mode:='specified'; END IF;
     m.focus:=CASE WHEN m.guided AND field=0 THEN 1 ELSE -1 END;
     m.state:='draft';
   ELSIF p_op='novar' THEN
     m.variant_mode:='none'; m.variant:=''; m.focus:=-1; m.state:='draft'; m.guided:=false;
   ELSIF p_op IN('confirm','uncertain') THEN
     IF p_op='confirm' AND (m.manufacturer='' OR m.model='' OR m.variant_mode='unknown'
       OR(m.variant_mode='specified' AND m.variant='') OR m.focus>=0
       OR(prompt.actor IS NOT NULL AND prompt.expires_at>now()))
     THEN RAISE EXCEPTION 'DOCUMENT_MODEL_INCOMPLETE'; END IF;
     m.state:=CASE WHEN p_op='confirm' THEN 'confirmed' ELSE 'needs_review' END;
     m.focus:=-1; m.guided:=false;
     INSERT INTO document_model_decisions(review_id,row_index,base_revision,actor,decision,identity,source_snapshot)
       VALUES(p_id,p_row,m.revision,p_actor,m.state,jsonb_build_object('manufacturer',m.manufacturer,
       'model',m.model,'variant_mode',m.variant_mode,'variant',m.variant),snapshot);
     INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_model_decision',
       jsonb_build_object('review_id',p_id,'row_index',p_row,'revision',m.revision,'decision',m.state));
   ELSIF p_op='cancel' THEN
     m.focus:=-1; m.guided:=false; m.state:='draft';
   END IF;
   IF p_op<>'bind' THEN
     m.revision:=m.revision+1;
     UPDATE document_model_checks SET revision=m.revision,source_hash=m.source_hash,manufacturer=m.manufacturer,
       model=m.model,variant_mode=m.variant_mode,variant=m.variant,state=m.state,focus=m.focus,guided=m.guided,updated_at=now()
       WHERE review_id=p_id AND row_index=p_row;
     IF m.focus>=0 THEN
       INSERT INTO document_review_prompts(actor,review_id,revision,row_index,column_index,message_id,kind,expires_at)
         VALUES(p_actor,p_id,m.revision,p_row,m.focus,NULL,'model',now()+interval '24 hours')
         ON CONFLICT(actor) DO UPDATE SET review_id=excluded.review_id,revision=excluded.revision,row_index=excluded.row_index,
           column_index=excluded.column_index,message_id=NULL,kind='model',expires_at=excluded.expires_at;
     ELSE
       DELETE FROM document_review_prompts WHERE actor=p_actor AND kind='model' AND review_id=p_id AND row_index=p_row;
     END IF;
   END IF;
 END IF;
 SELECT to_jsonb(q) INTO current_prompt FROM document_review_prompts q
   WHERE actor=p_actor AND kind='model' AND review_id=p_id AND row_index=p_row AND expires_at>now();
 SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY created_at DESC),'[]') INTO history FROM
   (SELECT id,decision,identity,created_at FROM document_model_decisions
    WHERE review_id=p_id AND row_index=p_row ORDER BY created_at DESC,id DESC LIMIT 10) q;
 RETURN jsonb_build_object('ok',true,'id',p_id,'row',p_row,'revision',CASE WHEN missing THEN 0 ELSE m.revision END,
   'file_name',d.file_name,'document_id',d.id,'table_label',t->>'label','header',h,'cells',v.cells,
   'row_revision',r.revision,'eligible',eligible,'stale',NOT missing AND m.source_hash<>fingerprint,
   'state',CASE WHEN missing THEN 'draft' ELSE m.state END,'manufacturer',coalesce(m.manufacturer,''),
   'model',coalesce(m.model,''),'variant_mode',coalesce(m.variant_mode,'unknown'),'variant',coalesce(m.variant,''),
   'focus',coalesce(m.focus,-1),'prompt',current_prompt,'history',history,'notice',notice,
   'usable',NOT missing AND eligible AND m.source_hash=fingerprint AND m.state='confirmed');
END $$;
REVOKE ALL ON FUNCTION public.bot_document_model(bigint,text,uuid,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_document_model(bigint,text,uuid,integer,integer,jsonb) TO service_role;
