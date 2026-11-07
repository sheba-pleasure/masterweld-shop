-- DEV first. Correct derived table structure; keep originals and OCR output immutable.
ALTER TABLE public.document_reviews
 ADD COLUMN header_override jsonb CHECK(header_override IS NULL OR (jsonb_typeof(header_override)='array' AND jsonb_array_length(header_override) BETWEEN 2 AND 30)),
 ADD COLUMN structure_draft jsonb;
ALTER TABLE public.document_review_rows
 ADD COLUMN display_order numeric,
 ADD COLUMN source_row integer,
 ADD COLUMN origin text NOT NULL DEFAULT 'ocr' CHECK(origin IN('ocr','manual','split')),
 ADD COLUMN source_note text NOT NULL DEFAULT '',
 ADD COLUMN parent_row integer,
 ADD COLUMN retired boolean NOT NULL DEFAULT false,
 ADD FOREIGN KEY(review_id,parent_row) REFERENCES public.document_review_rows(review_id,row_index);
ALTER TABLE public.document_review_prompts ADD COLUMN kind text NOT NULL DEFAULT 'cell' CHECK(kind IN('cell','structure'));
CREATE TABLE public.document_structure_changes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 review_id uuid NOT NULL REFERENCES public.document_reviews(id),
 actor bigint NOT NULL REFERENCES public.staff(telegram_id),
 kind text NOT NULL CHECK(kind IN('header','add','split')),
 base_revision integer NOT NULL,
 applied_revision integer NOT NULL,
 before_value jsonb NOT NULL,
 after_value jsonb NOT NULL,
 target_row integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 undone_at timestamptz,
 UNIQUE(review_id,base_revision)
);
ALTER TABLE public.document_structure_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_structure_changes FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION mw_private.document_structure(p_actor bigint,p_op text,p_id uuid,p_revision integer,
 p_row integer,p_column integer,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r document_reviews%ROWTYPE; v document_review_rows%ROWTYPE; p document_review_prompts%ROWTYPE;
 e document_structure_changes%ROWTYPE; draft jsonb; h jsonb; d jsonb; before_data jsonb;
 after_data jsonb; cells jsonb; parts integer; i integer; j integer; new_id integer; ids jsonb:='[]';
 column_count integer; part integer; col integer; value text; segments text[];
 here numeric; following numeric; focus integer; target integer:=p_row; delta integer:=1;
BEGIN
 SELECT q.* INTO r FROM document_reviews q JOIN document_intakes a ON a.id=q.document_id
   WHERE q.id=p_id AND a.staff_telegram_id=p_actor FOR UPDATE OF q;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND'; END IF;
 IF p_op='apply' THEN
   SELECT * INTO e FROM document_structure_changes WHERE review_id=r.id AND base_revision=p_revision;
   IF FOUND THEN RETURN jsonb_build_object('row',e.target_row,'notice','Изменение уже сохранено. Открыт текущий разбор.'); END IF;
 END IF;
 IF p_op='undo' THEN
   SELECT * INTO e FROM document_structure_changes WHERE review_id=r.id AND applied_revision=p_revision;
   IF FOUND AND e.undone_at IS NOT NULL THEN
     RETURN jsonb_build_object('row',e.target_row,'notice','Это изменение уже отменено.');
   END IF;
 END IF;
 IF r.handed_import_id IS NOT NULL THEN RAISE EXCEPTION 'DOCUMENT_FROZEN'; END IF;
 IF r.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'DOCUMENT_STALE'; END IF;
 SELECT * INTO v FROM document_review_rows WHERE review_id=r.id AND row_index=p_row;
 IF NOT FOUND OR (v.retired AND p_op<>'undo') THEN RAISE EXCEPTION 'DOCUMENT_ROW_REPLACED'; END IF;
 SELECT extraction->'tables'->r.table_index INTO d FROM document_intakes WHERE id=r.document_id;
 h:=coalesce(r.header_override,d->'header'); column_count:=jsonb_array_length(h);
 draft:=r.structure_draft;
 IF p_op IN('head','add','split') THEN
   IF draft IS NOT NULL THEN RAISE EXCEPTION 'DOCUMENT_STRUCTURE_ACTIVE'; END IF;
   IF EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=p_actor AND expires_at>now())
   THEN RAISE EXCEPTION 'DOCUMENT_INPUT_ACTIVE'; END IF;
   IF p_op='head' THEN
     IF p_column IS NULL OR p_column NOT BETWEEN 0 AND column_count-1 THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
     draft:=jsonb_build_object('kind','header','column',p_column,'value',h->>p_column);
   ELSE
     parts:=CASE WHEN p_op='add' THEN 1 ELSE p_column END;
     IF parts IS NULL OR parts NOT BETWEEN 1 AND 4 OR(p_op='split' AND parts<2) THEN RAISE EXCEPTION 'DOCUMENT_STRUCTURE_PARTS'; END IF;
     IF (SELECT coalesce(max(row_index),-1) FROM document_review_rows WHERE review_id=r.id)+parts>4999
     THEN RAISE EXCEPTION 'DOCUMENT_CAPACITY'; END IF;
     cells:='[]';
     FOR i IN 0..parts-1 LOOP
       after_data:='[]';
       FOR j IN 0..column_count-1 LOOP
         -- Only explicit matching line breaks suggest per-product values. Shared/ambiguous values stay blank.
         segments:=string_to_array(replace(coalesce(v.cells->>j,''),E'\r',''),E'\n');
         value:=CASE WHEN p_op='split' AND cardinality(segments)=parts THEN btrim(segments[i+1]) ELSE '' END;
         after_data:=after_data||jsonb_build_array(value);
       END LOOP;
       cells:=cells||jsonb_build_array(after_data);
     END LOOP;
     draft:=jsonb_build_object('kind',p_op,'rows',cells,'note',CASE WHEN p_op='split' THEN v.source_note ELSE '' END);
   END IF;
   draft:=draft||jsonb_build_object('target',p_row,'stage','editing','focus',-2,'guided',false);
 ELSIF p_op='undo' THEN
   IF draft IS NOT NULL OR EXISTS(SELECT 1 FROM document_review_prompts WHERE actor=p_actor AND expires_at>now())
   THEN RAISE EXCEPTION 'DOCUMENT_STRUCTURE_ACTIVE'; END IF;
   SELECT * INTO e FROM document_structure_changes WHERE review_id=r.id AND applied_revision=r.revision AND undone_at IS NULL;
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_UNDO_CONFLICT'; END IF;
   IF e.kind='header' THEN
     UPDATE document_reviews SET header_override=NULLIF(e.before_value->'header_override','null'::jsonb) WHERE id=r.id;
     UPDATE document_review_rows q SET decision=x.decision,decided_by=x.decided_by,decided_at=x.decided_at
       FROM jsonb_to_recordset(e.before_value->'approvals') x(row_index integer,decision text,decided_by bigint,decided_at timestamptz)
       WHERE q.review_id=r.id AND q.row_index=x.row_index;
   ELSE
     UPDATE document_review_rows SET retired=true,decision='excluded',decided_by=p_actor,decided_at=now()
       WHERE review_id=r.id AND row_index IN(SELECT jsonb_array_elements_text(e.after_value->'ids')::integer);
     IF e.kind='split' THEN
       UPDATE document_review_rows SET retired=false,decision=e.before_value->'row'->>'decision',
         decided_by=(e.before_value->'row'->>'decided_by')::bigint,decided_at=(e.before_value->'row'->>'decided_at')::timestamptz
         WHERE review_id=r.id AND row_index=e.target_row;
     END IF;
   END IF;
   UPDATE document_structure_changes SET undone_at=now() WHERE id=e.id;
   UPDATE document_reviews SET revision=revision+1 WHERE id=r.id;
   INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_structure_undo',jsonb_build_object('change_id',e.id,'review_id',r.id));
   RETURN jsonb_build_object('row',e.target_row,'notice','Изменение структуры отменено. Проверьте восстановленные строки.');
 ELSE
   IF draft IS NULL THEN RAISE EXCEPTION 'DOCUMENT_STRUCTURE_MISSING'; END IF;
   IF (draft->>'target')::integer<>p_row THEN RAISE EXCEPTION 'DOCUMENT_STALE'; END IF;
   IF p_op='cancel' THEN
     UPDATE document_reviews SET structure_draft=NULL,revision=revision+1 WHERE id=r.id;
     DELETE FROM document_review_prompts WHERE actor=p_actor AND review_id=r.id;
     RETURN jsonb_build_object('row',p_row,'notice','Черновик структуры отменён. Прежняя таблица сохранена.');
   ELSIF p_op='bind' THEN
     IF coalesce(p_payload->>'message_id','') !~ '^[1-9][0-9]{0,15}$' THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
     UPDATE document_review_prompts SET message_id=(p_payload->>'message_id')::bigint
      WHERE actor=p_actor AND review_id=r.id AND revision=r.revision AND kind='structure'
        AND column_index=p_column AND column_index>=-1 AND message_id IS NULL AND expires_at>now();
     IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
     RETURN jsonb_build_object('row',p_row);
   ELSIF p_op='apply' THEN
     IF draft->>'stage'<>'preview' THEN RAISE EXCEPTION 'DOCUMENT_STRUCTURE_PREVIEW'; END IF;
     before_data:=jsonb_build_object('header_override',r.header_override,'row',to_jsonb(v));
     IF draft->>'kind'='header' THEN
       SELECT before_data||jsonb_build_object('approvals',coalesce(jsonb_agg(jsonb_build_object('row_index',row_index,
         'decision',decision,'decided_by',decided_by,'decided_at',decided_at)),'[]')) INTO before_data
         FROM document_review_rows WHERE review_id=r.id AND decision='approved' AND NOT retired;
       UPDATE document_reviews SET header_override=jsonb_set(h,ARRAY[draft->>'column'],draft->'value') WHERE id=r.id;
       UPDATE document_review_rows SET decision='pending',decided_by=NULL,decided_at=NULL
         WHERE review_id=r.id AND decision='approved' AND NOT retired;
       after_data:=jsonb_build_object('header',jsonb_set(h,ARRAY[draft->>'column'],draft->'value'));
     ELSE
       parts:=jsonb_array_length(draft->'rows');
       SELECT coalesce(max(row_index),-1)+1 INTO new_id FROM document_review_rows WHERE review_id=r.id;
       IF new_id+parts>5000 THEN RAISE EXCEPTION 'DOCUMENT_CAPACITY'; END IF;
       here:=coalesce(v.display_order,v.row_index);
       SELECT min(coalesce(display_order,row_index)) INTO following FROM document_review_rows
         WHERE review_id=r.id AND NOT retired AND coalesce(display_order,row_index)>here;
       following:=coalesce(following,here+1);
       IF draft->>'kind'='split' THEN
         UPDATE document_review_rows SET retired=true WHERE review_id=r.id AND row_index=p_row;
       END IF;
       FOR i IN 0..parts-1 LOOP
         INSERT INTO document_review_rows(review_id,row_index,cells,display_order,source_row,origin,source_note,parent_row)
           VALUES(r.id,new_id+i,draft->'rows'->i,here+(following-here)*(i+1)/(parts+1),
             CASE WHEN draft->>'kind'='split' THEN CASE WHEN v.origin='ocr' THEN v.row_index ELSE v.source_row END ELSE NULL END,
             CASE WHEN draft->>'kind'='split' THEN 'split' ELSE 'manual' END,coalesce(draft->>'note',''),
             CASE WHEN draft->>'kind'='split' THEN p_row ELSE NULL END);
         ids:=ids||jsonb_build_array(new_id+i);
       END LOOP;
       after_data:=jsonb_build_object('rows',draft->'rows','ids',ids,'note',draft->>'note');
       target:=new_id;
     END IF;
     INSERT INTO document_structure_changes(review_id,actor,kind,base_revision,applied_revision,before_value,after_value,target_row)
       VALUES(r.id,p_actor,draft->>'kind',r.revision,r.revision+1,before_data,after_data,p_row) RETURNING * INTO e;
     UPDATE document_reviews SET structure_draft=NULL,revision=revision+1 WHERE id=r.id;
     DELETE FROM document_review_prompts WHERE actor=p_actor AND review_id=r.id;
     INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_structure_apply',
       jsonb_build_object('change_id',e.id,'review_id',r.id,'kind',e.kind,'revision',r.revision+1));
     RETURN jsonb_build_object('row',target,'notice','Структура исправлена. Теперь проверьте новые или затронутые строки. Товары в магазине не изменены.');
   ELSE
     IF draft->>'stage'='preview' AND p_op<>'back' THEN RAISE EXCEPTION 'DOCUMENT_STRUCTURE_PREVIEW'; END IF;
     IF p_op='back' THEN
       draft:=draft||'{"stage":"editing","focus":-2,"guided":false}';
     ELSIF p_op='focus' THEN
       IF p_column IS NULL OR p_column < -1 OR
         (p_column=-1 AND draft->>'kind'='header') OR
         (p_column>=0 AND draft->>'kind'='header' AND p_column<>(draft->>'column')::integer) OR
         (p_column>=0 AND draft->>'kind'<>'header' AND (p_column/30>=jsonb_array_length(draft->'rows') OR p_column%30>=column_count))
       THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
       draft:=draft||jsonb_build_object('focus',p_column,'guided',coalesce((p_payload->>'guided')::boolean,false));
     ELSIF p_op IN('standard','save','skip','copy','where') THEN
       SELECT * INTO p FROM document_review_prompts WHERE actor=p_actor;
       IF p_op='save' AND(NOT FOUND OR p.kind<>'structure' OR p.review_id<>r.id OR p.revision<>r.revision
         OR p.message_id IS NULL OR p.expires_at<=now() OR p_payload->>'reply_to' IS DISTINCT FROM p.message_id::text
         OR p.column_index IS DISTINCT FROM p_column)
       THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
       IF p_op='standard' THEN
         IF draft->>'kind'<>'header' OR p_column IS NULL OR p_column NOT BETWEEN 0 AND 7 THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
         value:=(ARRAY['sku','title','brand','price','cost_price','in_stock','stock_qty','category_slug'])[p_column+1];
         col:=(draft->>'column')::integer;
       ELSE
         IF p_column IS NULL OR p_column < -1 THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
         col:=p_column%30; part:=p_column/30;
         IF p_column>=0 AND ((draft->>'kind'='header' AND p_column<>(draft->>'column')::integer)
           OR(draft->>'kind'<>'header' AND(part>=jsonb_array_length(draft->'rows') OR col>=column_count)))
         THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
         IF p_op='copy' THEN
           IF draft->>'kind'<>'split' OR p_column<0 THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
           value:=coalesce(v.cells->>col,'');
         ELSIF p_op='skip' THEN
           IF draft->>'kind'='header' OR p_column<0 THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
           value:='';
         ELSIF p_op='where' THEN
           IF p_column<>-1 OR draft->>'kind'='header' THEN RAISE EXCEPTION 'DOCUMENT_COLUMN'; END IF;
           value:='Место в исходном файле не определено; требуется сверка человеком.';
         ELSE
           IF jsonb_typeof(p_payload->'value') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'DOCUMENT_VALUE'; END IF;
           value:=btrim(p_payload->>'value');
         END IF;
       END IF;
       IF draft->>'kind'='header' THEN
         IF length(value) NOT BETWEEN 1 AND 100 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(h) WITH ORDINALITY x(label,n)
           WHERE n-1<>(draft->>'column')::integer AND lower(btrim(label))=lower(value))
         THEN RAISE EXCEPTION 'DOCUMENT_HEADER'; END IF;
         draft:=draft||jsonb_build_object('value',value,'focus',-2,'guided',false);
       ELSIF p_column=-1 THEN
         IF length(value) NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'DOCUMENT_SOURCE_NOTE'; END IF;
         draft:=draft||jsonb_build_object('note',value,'focus',-2,'guided',false);
       ELSE
         IF length(value)>2000 THEN RAISE EXCEPTION 'DOCUMENT_VALUE'; END IF;
         draft:=jsonb_set(draft,ARRAY['rows',part::text,col::text],to_jsonb(value));
         focus:=-2;
         IF (draft->>'guided')::boolean THEN
           IF col+1<column_count THEN focus:=p_column+1;
           ELSIF part+1<jsonb_array_length(draft->'rows') THEN focus:=(part+1)*30;
           ELSIF draft->>'kind'='add' AND coalesce(draft->>'note','')='' THEN focus:=-1;
           END IF;
         END IF;
         draft:=draft||jsonb_build_object('focus',focus);
       END IF;
     ELSIF p_op='preview' THEN
       IF draft->>'kind'='header' THEN
         IF (draft->>'value')=(h->>((draft->>'column')::integer)) THEN RAISE EXCEPTION 'DOCUMENT_NO_CHANGE'; END IF;
       ELSE
         IF EXISTS(SELECT 1 FROM jsonb_array_elements(draft->'rows') row_data
           WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(row_data) AS cell(content) WHERE btrim(cell.content)<>''))
         THEN RAISE EXCEPTION 'DOCUMENT_EMPTY_PRODUCT'; END IF;
         IF draft->>'kind'='add' AND coalesce(draft->>'note','')='' THEN RAISE EXCEPTION 'DOCUMENT_SOURCE_NOTE'; END IF;
       END IF;
       draft:=draft||'{"stage":"preview","focus":-2,"guided":false}';
     ELSE RAISE EXCEPTION 'DOCUMENT_OP'; END IF;
   END IF;
 END IF;
 UPDATE document_reviews SET structure_draft=draft,revision=revision+delta WHERE id=r.id RETURNING * INTO r;
 INSERT INTO document_review_prompts(actor,review_id,revision,row_index,column_index,kind)
   VALUES(p_actor,r.id,r.revision,p_row,(draft->>'focus')::integer,'structure')
   ON CONFLICT(actor) DO UPDATE SET review_id=excluded.review_id,revision=excluded.revision,
     row_index=excluded.row_index,column_index=excluded.column_index,kind='structure',message_id=NULL,expires_at=now()+interval '24 hours';
 RETURN jsonb_build_object('row',p_row);
END $$;
REVOKE ALL ON FUNCTION mw_private.document_structure(bigint,text,uuid,integer,integer,integer,jsonb) FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION public.bot_document_review(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,
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
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(t->'rows') x WHERE jsonb_array_length(x)>30)
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
 t:=jsonb_set(t,'{header}',coalesce(r.header_override,t->'header'));
 IF p_op LIKE 'st_%' THEN
   result:=mw_private.document_structure(p_actor,substring(p_op from 4),r.id,p_revision,p_row,p_column,p_payload);
   RETURN public.bot_document_review(p_actor,'get',r.id,NULL,(result->>'row')::integer)||jsonb_build_object('notice',result->>'notice');
 END IF;
 IF p_op NOT IN('open','get','next','summary','edit','bind','save','cancel','approve','exclude','pending','handoff')
 THEN RAISE EXCEPTION 'DOCUMENT_OP'; END IF;
 IF p_op='handoff' AND r.handed_import_id IS NOT NULL THEN
   RETURN jsonb_build_object('ok',true,'import_id',r.handed_import_id);
 END IF;
 IF p_op IN('edit','bind','save','cancel','approve','exclude','pending','handoff') THEN
   IF r.structure_draft IS NOT NULL THEN RAISE EXCEPTION 'DOCUMENT_STRUCTURE_ACTIVE'; END IF;
   IF r.handed_import_id IS NOT NULL THEN RAISE EXCEPTION 'DOCUMENT_FROZEN'; END IF;
   IF p_revision IS DISTINCT FROM r.revision THEN RAISE EXCEPTION 'DOCUMENT_STALE'; END IF;
 END IF;
 IF r.structure_draft IS NOT NULL AND p_op IN('open','get','next','summary') THEN target:=(r.structure_draft->>'target')::integer; END IF;
 SELECT * INTO v FROM document_review_rows WHERE review_id=r.id AND row_index=target;
 IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_ROW'; END IF;
 IF v.retired THEN
   IF p_op NOT IN('open','get','next','summary') THEN RAISE EXCEPTION 'DOCUMENT_ROW_REPLACED'; END IF;
   SELECT * INTO v FROM document_review_rows WHERE review_id=r.id AND NOT retired
     ORDER BY CASE WHEN coalesce(display_order,row_index)>=coalesce(v.display_order,v.row_index) THEN 0 ELSE 1 END,
       coalesce(display_order,row_index),row_index LIMIT 1;
   target:=v.row_index;
 END IF;
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
       row_index=excluded.row_index,column_index=excluded.column_index,kind='cell',message_id=NULL,expires_at=now()+interval '24 hours';
 ELSIF p_op='bind' THEN
   IF coalesce(p_payload->>'message_id','') !~ '^[1-9][0-9]{0,15}$' THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
   UPDATE document_review_prompts SET message_id=(p_payload->>'message_id')::bigint
    WHERE actor=p_actor AND review_id=r.id AND revision=r.revision AND row_index=target
      AND kind='cell' AND column_index=p_column AND message_id IS NULL AND expires_at>now();
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_PROMPT'; END IF;
 ELSIF p_op='save' THEN
   SELECT * INTO prompt FROM document_review_prompts WHERE actor=p_actor;
   IF NOT FOUND OR prompt.kind<>'cell' OR prompt.review_id<>r.id OR prompt.revision<>r.revision OR prompt.row_index<>target
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
   IF EXISTS(SELECT 1 FROM document_review_rows WHERE review_id=r.id AND NOT retired AND decision='pending')
     OR NOT EXISTS(SELECT 1 FROM document_review_rows WHERE review_id=r.id AND NOT retired AND decision='approved')
   THEN RAISE EXCEPTION 'DOCUMENT_UNREVIEWED'; END IF;
   SELECT import_id INTO linked FROM document_import_links WHERE document_id=d.id AND table_index=r.table_index;
   IF linked IS NOT NULL AND EXISTS(SELECT 1 FROM catalog_imports WHERE id=linked AND state<>'canceled')
   THEN RAISE EXCEPTION 'DOCUMENT_LEGACY_IMPORT'; END IF;
   SELECT jsonb_build_object('header',t->'header','rows',jsonb_agg(cells ORDER BY coalesce(display_order,row_index),row_index),
      'original_header',d.extraction->'tables'->r.table_index->'header',
      'provenance',jsonb_agg(jsonb_build_object('source_row',CASE WHEN origin='ocr' THEN row_index ELSE source_row END,
        'locator',t->'row_locators'->(CASE WHEN origin='ocr' THEN row_index ELSE source_row END),
        'review_row_id',row_index,'origin',origin,'note',source_note,'parent_row',parent_row)
         ORDER BY coalesce(display_order,row_index),row_index),
      'document_id',d.id,'original_sha256',d.checksum,'review_id',r.id,'review_revision',r.revision)
     INTO src FROM document_review_rows WHERE review_id=r.id AND NOT retired AND decision='approved';
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
   'total',count(*)) INTO counts FROM document_review_rows WHERE review_id=r.id AND NOT retired;
 IF p_op IN('next','approve','exclude') AND r.structure_draft IS NULL THEN
   SELECT row_index INTO idx FROM document_review_rows WHERE review_id=r.id AND NOT retired AND decision='pending'
     ORDER BY CASE WHEN coalesce(display_order,row_index)>coalesce(v.display_order,v.row_index) THEN 0 ELSE 1 END,coalesce(display_order,row_index),row_index LIMIT 1;
   target:=coalesce(idx,target);
 END IF;
 SELECT * INTO v FROM document_review_rows WHERE review_id=r.id AND row_index=target;
 SELECT import_id INTO linked FROM document_import_links WHERE document_id=d.id AND table_index=r.table_index;
 RETURN jsonb_build_object('ok',true,'id',r.id,'document_id',d.id,'revision',r.revision,
   'file_name',d.file_name,'table_label',t->>'label','header',t->'header',
   'row',target,'cells',v.cells,
   'position',(SELECT count(*) FROM document_review_rows WHERE review_id=r.id AND NOT retired AND coalesce(display_order,row_index)<=coalesce(v.display_order,v.row_index)),
   'prev_row',(SELECT row_index FROM document_review_rows WHERE review_id=r.id AND NOT retired AND coalesce(display_order,row_index)<coalesce(v.display_order,v.row_index) ORDER BY coalesce(display_order,row_index) DESC LIMIT 1),
   'next_row',(SELECT row_index FROM document_review_rows WHERE review_id=r.id AND NOT retired AND coalesce(display_order,row_index)>coalesce(v.display_order,v.row_index) ORDER BY coalesce(display_order,row_index) LIMIT 1),
   'original',coalesce(t->'rows'->(CASE WHEN v.origin='ocr' THEN target ELSE v.source_row END),'[]'::jsonb),
   'original_header',d.extraction->'tables'->r.table_index->'header',
   'locator',t->'row_locators'->(CASE WHEN v.origin='ocr' THEN target ELSE v.source_row END),
   'source_origin',v.origin,'source_note',v.source_note,'parent_row',v.parent_row,
   'structure_draft',r.structure_draft,
   'last_structure_change',(SELECT jsonb_build_object('kind',kind,'target_row',target_row,'revision',applied_revision,
       'can_undo',applied_revision=r.revision AND undone_at IS NULL AND r.structure_draft IS NULL AND r.handed_import_id IS NULL)
     FROM document_structure_changes WHERE review_id=r.id ORDER BY applied_revision DESC LIMIT 1),
   'decision',v.decision,'counts',counts,'import_id',r.handed_import_id,
   'legacy_import_id',CASE WHEN r.handed_import_id IS NULL THEN linked ELSE NULL END,
   'warnings',coalesce(t->'warnings','[]')||coalesce(d.extraction->'warnings','[]'),
   'coverage',d.extraction->'coverage');
END $$;
REVOKE ALL ON FUNCTION public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_document_review(bigint,text,uuid,integer,integer,integer,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
