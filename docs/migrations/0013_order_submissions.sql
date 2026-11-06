-- Durable checkout attempt. Never expire/delete receipts while retries may arrive.
-- Service-only: browsers cannot inspect attempts or provide trusted totals directly.
CREATE TABLE public.order_submissions (
 request_id uuid PRIMARY KEY,
 payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
 order_id uuid UNIQUE REFERENCES public.shop_orders(id) ON DELETE RESTRICT,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.order_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_submissions FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.lookup_order_submission(p_request_id uuid, p_payload_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE receipt public.order_submissions;
BEGIN
 IF p_request_id IS NULL OR p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'INVALID_ORDER_ATTEMPT'; END IF;
 SELECT * INTO receipt FROM public.order_submissions WHERE request_id=p_request_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF receipt.payload_hash<>p_payload_hash THEN RAISE EXCEPTION 'ORDER_ATTEMPT_CONFLICT'; END IF;
 RETURN receipt.result;
END $$;

CREATE FUNCTION public.commit_order_submission(
 p_request_id uuid, p_payload_hash text, p_name text, p_phone text,
 p_comment text, p_items jsonb, p_total numeric, p_has_backorder boolean, p_rejection jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE receipt jsonb; new_id uuid; response jsonb;
BEGIN
 IF p_request_id IS NULL OR p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$'
 THEN RAISE EXCEPTION 'INVALID_ORDER_ATTEMPT'; END IF;
 -- Transaction lock serializes equal attempts, including overlapping HTTP requests.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
 receipt := public.lookup_order_submission(p_request_id,p_payload_hash);
 IF receipt IS NOT NULL THEN RETURN receipt; END IF;
 IF p_rejection IS NOT NULL THEN
   IF p_rejection->>'ok' <> 'false' OR coalesce(p_rejection->>'code','') NOT IN ('REJECTED','PRICE_CHANGED')
   THEN RAISE EXCEPTION 'INVALID_ORDER_REJECTION'; END IF;
   INSERT INTO public.order_submissions(request_id,payload_hash,result)
   VALUES(p_request_id,p_payload_hash,p_rejection);
   RETURN p_rejection;
 END IF;
 INSERT INTO public.shop_orders(name,phone,comment,items,total)
 VALUES(p_name,p_phone,p_comment,p_items,p_total) RETURNING id INTO new_id;
 response := jsonb_build_object('ok',true,'number','#'||left(new_id::text,8),
   'total',p_total,'hasBackorder',p_has_backorder);
 INSERT INTO public.order_submissions(request_id,payload_hash,order_id,result)
 VALUES(p_request_id,p_payload_hash,new_id,response);
 RETURN response;
END $$;
REVOKE ALL ON FUNCTION public.lookup_order_submission(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.commit_order_submission(uuid,text,text,text,text,jsonb,numeric,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_order_submission(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_order_submission(uuid,text,text,text,text,jsonb,numeric,boolean,jsonb) TO service_role;
-- Old application versions must fail closed instead of bypassing durable receipts.
REVOKE INSERT ON public.shop_orders FROM service_role;
NOTIFY pgrst, 'reload schema';
