-- Future identity changes invalidate published technical facts and every old preview.
-- Existing revisions, sources and product rows remain unchanged during installation.
CREATE TABLE public.technical_identity_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 product_id uuid NOT NULL REFERENCES public.products(id),
 card_version bigint NOT NULL CHECK(card_version>0),
 previous_revision uuid REFERENCES public.technical_revisions(id),
 old_identity jsonb NOT NULL,
 new_identity jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(product_id,card_version)
);
ALTER TABLE public.technical_identity_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.technical_identity_events FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION mw_private.technical_product_identity_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $identity$
DECLARE old_value jsonb; new_value jsonb; previous uuid; version_now bigint;
BEGIN
 old_value:=mw_private.document_product_identity(OLD);
 new_value:=mw_private.document_product_identity(NEW);
 IF old_value IS NOT DISTINCT FROM new_value THEN RETURN NEW; END IF;
 -- The product row is already locked by UPDATE. All technical writes lock product before card.
 SELECT published_revision INTO previous FROM technical_cards WHERE product_id=NEW.id FOR UPDATE;
 INSERT INTO technical_cards(product_id,version,published_revision) VALUES(NEW.id,1,NULL)
 ON CONFLICT(product_id) DO UPDATE
  SET version=technical_cards.version+1,published_revision=NULL
 RETURNING version INTO version_now;
 INSERT INTO technical_identity_events(product_id,card_version,previous_revision,old_identity,new_identity)
  VALUES(NEW.id,version_now,previous,old_value,new_value);
 RETURN NEW;
END $identity$;
REVOKE ALL ON FUNCTION mw_private.technical_product_identity_changed() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER products_technical_identity_changed
 AFTER UPDATE OF sku,title,brand,category_id ON public.products
 FOR EACH ROW EXECUTE FUNCTION mw_private.technical_product_identity_changed();

-- Keep one mutation implementation. The public wrapper adds staff-only recovery information.
ALTER FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint)
 RENAME TO bot_technical_catalog_before_identity;
ALTER FUNCTION public.bot_technical_catalog_before_identity(bigint,text,uuid,uuid,jsonb,text,bigint)
 SET SCHEMA mw_private;
REVOKE ALL ON FUNCTION mw_private.bot_technical_catalog_before_identity(bigint,text,uuid,uuid,jsonb,text,bigint)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.bot_technical_catalog(
 p_staff_telegram_id bigint,p_op text,p_product_id uuid DEFAULT NULL,p_change_id uuid DEFAULT NULL,
 p_document jsonb DEFAULT NULL,p_review_state text DEFAULT 'pending_review',p_expected_version bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $reader$
DECLARE result jsonb; event technical_identity_events%ROWTYPE; previous uuid;
BEGIN
 result:=mw_private.bot_technical_catalog_before_identity(p_staff_telegram_id,p_op,p_product_id,p_change_id,
  p_document,p_review_state,p_expected_version);
 IF p_op='read' THEN
  SELECT * INTO event FROM technical_identity_events WHERE product_id=p_product_id ORDER BY card_version DESC LIMIT 1;
  IF FOUND AND result->'card'->>'published_revision' IS NULL THEN
   SELECT previous_revision INTO previous FROM technical_identity_events
    WHERE product_id=p_product_id AND previous_revision IS NOT NULL ORDER BY card_version DESC LIMIT 1;
   result:=jsonb_set(result,'{card,identity_review}',jsonb_build_object('required',true,'event_id',event.id,
    'changed_at',event.created_at,'previous_revision',previous));
  ELSE
   result:=jsonb_set(result,'{card,identity_review}',jsonb_build_object('required',false));
  END IF;
 END IF;
 RETURN result;
END $reader$;
REVOKE ALL ON FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bot_technical_catalog(bigint,text,uuid,uuid,jsonb,text,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
