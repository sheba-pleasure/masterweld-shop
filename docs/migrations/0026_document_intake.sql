-- DEV first. Originals/proposals are private and never publish catalog rows.
CREATE TABLE public.document_intakes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 staff_telegram_id bigint NOT NULL REFERENCES public.staff(telegram_id),
 checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
 file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
 original bytea NOT NULL CHECK (octet_length(original) BETWEEN 1 AND 5242880),
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','extracting','review','failed','canceled')),
 processor_version text NOT NULL DEFAULT 'document-v1',
 attempts integer NOT NULL DEFAULT 0,
 lease uuid, leased_at timestamptz,
 extraction jsonb, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(staff_telegram_id,checksum,processor_version)
);
ALTER TABLE public.document_intakes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_intakes FROM PUBLIC,anon,authenticated,service_role;
CREATE SCHEMA IF NOT EXISTS mw_private;
CREATE SEQUENCE mw_private.document_import_request START 100000000000000000 MAXVALUE 999999999999999999;
REVOKE ALL ON SEQUENCE mw_private.document_import_request FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.document_import_links (
 document_id uuid NOT NULL REFERENCES public.document_intakes(id),
 table_index integer NOT NULL,
 import_id uuid NOT NULL,
 PRIMARY KEY(document_id,table_index)
);
ALTER TABLE public.document_import_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.document_import_links FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE public.staff_enrollment_results (
 request_key text PRIMARY KEY,
 actor bigint NOT NULL,
 ids bigint[] NOT NULL,
 result jsonb NOT NULL
);
ALTER TABLE public.staff_enrollment_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_enrollment_results FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.bot_enroll_sellers(p_actor bigint,p_request_key text,p_ids bigint[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.staff%ROWTYPE; r public.staff_enrollment_results%ROWTYPE; target bigint; result jsonb;
BEGIN
 SELECT * INTO s FROM staff WHERE telegram_id=p_actor FOR UPDATE;
 IF NOT FOUND OR NOT s.active OR s.role::text<>'admin' THEN RAISE EXCEPTION 'STAFF_DENIED'; END IF;
 IF p_request_key IS NULL OR length(p_request_key) NOT BETWEEN 1 AND 150
   OR p_ids IS NULL OR cardinality(p_ids) NOT BETWEEN 1 AND 50
   OR EXISTS(SELECT 1 FROM unnest(p_ids) n WHERE n IS NULL OR n<=0 OR n>9007199254740991)
   OR cardinality(p_ids)<>(SELECT count(DISTINCT n) FROM unnest(p_ids) n)
 THEN RAISE EXCEPTION 'STAFF_INPUT'; END IF;
 SELECT * INTO r FROM staff_enrollment_results WHERE request_key=p_request_key;
 IF FOUND THEN
   IF r.actor<>p_actor OR r.ids<>p_ids THEN RAISE EXCEPTION 'STAFF_REQUEST_CONFLICT'; END IF;
   RETURN r.result;
 END IF;
 -- Never silently downgrade an existing administrator/director, reactivate, or change identity.
 PERFORM 1 FROM staff WHERE telegram_id=ANY(p_ids) FOR UPDATE;
 IF EXISTS(SELECT 1 FROM staff WHERE telegram_id=ANY(p_ids) AND
   (role::text<>'seller' OR NOT active OR elevated)) THEN RAISE EXCEPTION 'STAFF_EXISTING_REVIEW'; END IF;
 FOREACH target IN ARRAY p_ids LOOP
   INSERT INTO staff(telegram_id,name,role,active,elevated)
     VALUES(target,'Сотрудник '||target,'seller',true,false) ON CONFLICT(telegram_id) DO NOTHING;
 END LOOP;
 result:=jsonb_build_object('ok',true,'count',cardinality(p_ids),'role','seller');
 INSERT INTO staff_audit_log(telegram_id,action,details)
   VALUES(p_actor,'staff_enroll_sellers',jsonb_build_object('ids',p_ids,'request_key',p_request_key));
 INSERT INTO staff_enrollment_results VALUES(p_request_key,p_actor,p_ids,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.bot_enroll_sellers(bigint,text,bigint[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_enroll_sellers(bigint,text,bigint[]) TO service_role;

CREATE FUNCTION public.bot_document_intake(p_actor bigint,p_op text,p_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.staff%ROWTYPE; d public.document_intakes%ROWTYPE; bytes bytea; v_checksum text; result jsonb;
 t jsonb; mapping jsonb; n integer; linked uuid; col text; idx integer; v_request_key text;
BEGIN
 SELECT * INTO s FROM staff WHERE telegram_id=p_actor FOR UPDATE;
 IF NOT FOUND OR NOT s.active OR NOT(s.role::text='admin' OR(s.role::text='director' AND s.elevated))
 THEN RAISE EXCEPTION 'DOCUMENT_DENIED'; END IF;
 IF p_op='home' THEN
   RETURN jsonb_build_object('ok',true,'home',true,'recent',coalesce((
    SELECT jsonb_agg(x) FROM (SELECT id,file_name,state,created_at FROM document_intakes
    WHERE staff_telegram_id=p_actor ORDER BY created_at DESC LIMIT 10) x),'[]'::jsonb));
 ELSIF p_op='upload' THEN
   IF jsonb_typeof(p_payload)<>'object' OR length(p_payload->>'base64')>6990510 OR
      length(coalesce(p_payload->>'file_name','')) NOT BETWEEN 1 AND 200
   THEN RAISE EXCEPTION 'DOCUMENT_INPUT'; END IF;
   bytes:=decode(p_payload->>'base64','base64');
   IF bytes IS NULL OR octet_length(bytes) NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'DOCUMENT_SIZE'; END IF;
   v_checksum:=encode(sha256(bytes),'hex');
   SELECT * INTO d FROM document_intakes WHERE staff_telegram_id=p_actor
      AND document_intakes.checksum=v_checksum AND processor_version='document-v1';
   IF NOT FOUND THEN
     IF (SELECT count(*) FROM document_intakes WHERE staff_telegram_id=p_actor AND state IN('queued','extracting'))>=5
        OR (SELECT count(*) FROM document_intakes WHERE staff_telegram_id=p_actor AND created_at>now()-interval '1 day')>=30
     THEN RAISE EXCEPTION 'DOCUMENT_CAPACITY'; END IF;
     INSERT INTO document_intakes(staff_telegram_id,checksum,file_name,original)
       VALUES(p_actor,v_checksum,p_payload->>'file_name',bytes) RETURNING * INTO d;
     INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_upload',
       jsonb_build_object('id',d.id,'sha256',v_checksum));
   END IF;
 ELSE
   SELECT * INTO d FROM document_intakes WHERE id=p_id AND staff_telegram_id=p_actor FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'DOCUMENT_NOT_FOUND'; END IF;
   IF p_op='cancel' THEN
     IF d.state NOT IN('canceled','review','failed') THEN
       UPDATE document_intakes SET state='canceled',lease=NULL,updated_at=now() WHERE id=d.id RETURNING * INTO d;
       INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_cancel',jsonb_build_object('id',d.id));
     END IF;
   ELSIF p_op='table' THEN
     IF d.state<>'review' OR (p_payload->>'index') !~ '^[0-9]{1,3}$' THEN RAISE EXCEPTION 'DOCUMENT_TABLE'; END IF;
     n:=(p_payload->>'index')::integer;
     t:=d.extraction->'tables'->n;
     IF t IS NULL OR jsonb_typeof(t->'header')<>'array' OR jsonb_array_length(t->'header') NOT BETWEEN 2 AND 30
       OR jsonb_typeof(t->'rows')<>'array' OR jsonb_array_length(t->'rows') NOT BETWEEN 1 AND 5000
     THEN RAISE EXCEPTION 'DOCUMENT_TABLE'; END IF;
     SELECT import_id INTO linked FROM document_import_links WHERE document_id=d.id AND table_index=n;
     IF linked IS NOT NULL THEN RETURN public.bot_catalog_import(p_actor,'get',linked); END IF;
     -- Mapping remains a human decision. Do not promote supplier cost to retail price.
     mapping:='{"sku":-1,"title":-1,"brand":-1,"price":-1,"cost_price":-1,"in_stock":-1,"stock_qty":-1,"category_slug":-1}';
     idx:=0;
     FOR col IN SELECT jsonb_array_elements_text(t->'header') LOOP
       IF col IN('sku','title','brand','price','cost_price','in_stock','stock_qty','category_slug')
          AND (SELECT count(*) FROM jsonb_array_elements_text(t->'header') v WHERE v=col)=1
       THEN mapping:=jsonb_set(mapping,ARRAY[col],to_jsonb(idx)); END IF;
       idx:=idx+1;
     END LOOP;
     LOOP
       v_request_key:=nextval('mw_private.document_import_request')::text;
       EXIT WHEN NOT EXISTS(SELECT 1 FROM catalog_imports WHERE staff_telegram_id=p_actor AND catalog_imports.request_key=v_request_key);
     END LOOP;
     result:=public.bot_catalog_import(p_actor,'upload',NULL,
       jsonb_build_object('request_key',v_request_key,'checksum',d.checksum,
         'file_name',left(d.file_name||' · '||coalesce(t->>'label','таблица'),200),
         'source',jsonb_build_object('header',t->'header','rows',t->'rows'),'mapping',mapping),0,NULL);
     INSERT INTO document_import_links VALUES(d.id,n,(result->>'id')::uuid);
     INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_import_preview',
        jsonb_build_object('document_id',d.id,'table_index',n,'import_id',result->>'id'));
     RETURN result;
   ELSIF p_op='original' THEN
     INSERT INTO staff_audit_log(telegram_id,action,details) VALUES(p_actor,'document_original_read',jsonb_build_object('id',d.id));
     RETURN jsonb_build_object('ok',true,'id',d.id,'file_name',d.file_name,'checksum',d.checksum,'original_base64',encode(d.original,'base64'));
   ELSIF p_op='text' THEN
     RETURN jsonb_build_object('ok',true,'id',d.id,'file_name',d.file_name,'checksum',d.checksum,'extraction',d.extraction);
   ELSIF p_op<>'get' THEN RAISE EXCEPTION 'DOCUMENT_OP'; END IF;
 END IF;
 RETURN jsonb_build_object('ok',true,'id',d.id,'file_name',d.file_name,'state',d.state,
   'checksum',d.checksum,'error_code',d.error_code,
   'processor_version',d.processor_version,'extraction',d.extraction);
END $$;
REVOKE ALL ON FUNCTION public.bot_document_intake(bigint,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_document_intake(bigint,text,uuid,jsonb) TO service_role;

CREATE FUNCTION public.document_worker(p_op text,p_id uuid DEFAULT NULL,p_lease uuid DEFAULT NULL,p_result jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d public.document_intakes%ROWTYPE; valid boolean;
BEGIN
 IF p_op='claim' THEN
   UPDATE document_intakes SET state='failed',error_code='WORKER_INTERRUPTED',lease=NULL,updated_at=now()
    WHERE state='extracting' AND leased_at<now()-interval '10 minutes';
   SELECT q.* INTO d FROM document_intakes q JOIN staff s ON s.telegram_id=q.staff_telegram_id
     WHERE q.state='queued' AND s.active AND (s.role::text='admin' OR(s.role::text='director' AND s.elevated))
     ORDER BY q.created_at FOR UPDATE OF q SKIP LOCKED LIMIT 1;
   IF NOT FOUND THEN RETURN jsonb_build_object('idle',true); END IF;
   UPDATE document_intakes SET state='extracting',attempts=attempts+1,lease=gen_random_uuid(),leased_at=now(),updated_at=now()
     WHERE id=d.id RETURNING * INTO d;
   RETURN jsonb_build_object('id',d.id,'lease',d.lease,'file_name',d.file_name,'checksum',d.checksum,'base64',encode(d.original,'base64'));
 END IF;
 SELECT * INTO d FROM document_intakes WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR d.state<>'extracting' OR d.lease IS DISTINCT FROM p_lease OR p_lease IS NULL
 THEN RAISE EXCEPTION 'DOCUMENT_LEASE'; END IF;
 SELECT active AND(role::text='admin' OR(role::text='director' AND elevated)) INTO valid FROM staff WHERE telegram_id=d.staff_telegram_id;
 IF NOT coalesce(valid,false) THEN RAISE EXCEPTION 'DOCUMENT_DENIED'; END IF;
 IF p_op='finish' THEN
   IF p_result IS NULL OR jsonb_typeof(p_result)<>'object' OR octet_length(p_result::text)>5000000
      OR p_result->>'sha256' IS DISTINCT FROM d.checksum OR p_result->>'version' IS DISTINCT FROM 'document-v1'
      OR jsonb_typeof(p_result->'tables') IS DISTINCT FROM 'array' OR jsonb_typeof(p_result->'blocks') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'DOCUMENT_RESULT'; END IF;
   UPDATE document_intakes SET state='review',extraction=p_result,lease=NULL,updated_at=now() WHERE id=d.id;
 ELSIF p_op='fail' THEN
   UPDATE document_intakes SET state='failed',error_code='EXTRACTION_FAILED',lease=NULL,updated_at=now() WHERE id=d.id;
 ELSE RAISE EXCEPTION 'DOCUMENT_OP'; END IF;
 RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.document_worker(text,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.document_worker(text,uuid,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
