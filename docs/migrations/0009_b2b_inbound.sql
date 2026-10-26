-- REVIEW ONLY. NOT APPLIED. Live mail prohibited until Russian data residency/legal review.
CREATE TABLE public.b2b_leads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','qualification','first_contact','clarification','supplier_search','economics','proposal','follow_up','won','lost')),
 priority text NOT NULL DEFAULT 'manual', needs_review boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.b2b_leads TO service_role;
REVOKE ALL ON public.b2b_leads FROM anon, authenticated;
ALTER TABLE public.b2b_leads ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.b2b_messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lead_id uuid NOT NULL REFERENCES public.b2b_leads(id),
 mailbox text NOT NULL CHECK(mailbox='info@masterweld.ru'), message_id text NOT NULL,
 in_reply_to text, chain jsonb NOT NULL DEFAULT '[]', original jsonb NOT NULL, analysis jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(mailbox,message_id)
);
GRANT ALL ON public.b2b_messages TO service_role;
REVOKE ALL ON public.b2b_messages FROM anon, authenticated;
ALTER TABLE public.b2b_messages ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.b2b_drafts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), message_id uuid NOT NULL UNIQUE REFERENCES public.b2b_messages(id),
 draft jsonb NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK(status='DRAFT'), send_allowed boolean NOT NULL DEFAULT false CHECK(send_allowed=false)
);
GRANT ALL ON public.b2b_drafts TO service_role;
REVOKE ALL ON public.b2b_drafts FROM anon, authenticated;
ALTER TABLE public.b2b_drafts ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.b2b_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, lead_id uuid REFERENCES public.b2b_leads(id),
 kind text NOT NULL, actor bigint, created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.b2b_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.b2b_events_id_seq TO service_role;
REVOKE ALL ON public.b2b_events FROM anon, authenticated;
ALTER TABLE public.b2b_events ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.b2b_ingest_limits (
 bucket text PRIMARY KEY, hits integer NOT NULL DEFAULT 0, window_start timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.b2b_ingest_limits TO service_role;
REVOKE ALL ON public.b2b_ingest_limits FROM anon, authenticated;
ALTER TABLE public.b2b_ingest_limits ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.b2b_ingest(p_email jsonb,p_analysis jsonb,p_draft jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE existing public.b2b_messages; lid uuid; mid uuid; hits_now integer; parent_ids text[];
BEGIN
 IF p_email->>'mailbox' <> 'info@masterweld.ru' OR coalesce(length(p_email->>'messageId'),0)=0 OR length(p_email->>'text')>100000 OR p_draft->>'status'<>'DRAFT' OR p_draft->>'sendAllowed'<>'false' THEN RAISE EXCEPTION 'invalid payload'; END IF;
 -- Serialize mailbox writes: duplicate + thread lookup + rate + insert is one transaction.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_email->>'mailbox',0));
 SELECT * INTO existing FROM b2b_messages WHERE mailbox=p_email->>'mailbox' AND message_id=p_email->>'messageId';
 IF FOUND THEN RETURN jsonb_build_object('leadId',existing.lead_id,'duplicate',true); END IF;
 INSERT INTO b2b_ingest_limits(bucket) VALUES('mailbox') ON CONFLICT DO NOTHING;
 UPDATE b2b_ingest_limits SET hits=CASE WHEN window_start<now()-interval '1 minute' THEN 1 ELSE hits+1 END,
 window_start=CASE WHEN window_start<now()-interval '1 minute' THEN now() ELSE window_start END WHERE bucket='mailbox' RETURNING hits INTO hits_now;
 IF hits_now>30 THEN RAISE EXCEPTION 'B2B_RATE_LIMIT'; END IF;
 SELECT array_agg(value) INTO parent_ids FROM jsonb_array_elements_text(coalesce(p_email->'references','[]'));
 SELECT lead_id INTO lid FROM b2b_messages WHERE mailbox=p_email->>'mailbox' AND (message_id=p_email->>'inReplyTo' OR message_id=ANY(parent_ids)) ORDER BY created_at LIMIT 1;
 IF lid IS NULL THEN INSERT INTO b2b_leads(priority) VALUES(coalesce(p_analysis->>'priority','manual')) RETURNING id INTO lid; END IF;
 INSERT INTO b2b_messages(lead_id,mailbox,message_id,in_reply_to,chain,original,analysis) VALUES(lid,p_email->>'mailbox',p_email->>'messageId',p_email->>'inReplyTo',coalesce(p_email->'references','[]'),p_email,p_analysis) RETURNING id INTO mid;
 INSERT INTO b2b_drafts(message_id,draft) VALUES(mid,p_draft);
 INSERT INTO b2b_events(lead_id,kind) VALUES(lid,'received');
 RETURN jsonb_build_object('leadId',lid,'duplicate',false);
END $$;
REVOKE ALL ON FUNCTION public.b2b_ingest(jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.b2b_ingest(jsonb,jsonb,jsonb) TO service_role;
