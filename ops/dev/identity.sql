CREATE SCHEMA IF NOT EXISTS mw_private;
REVOKE ALL ON SCHEMA mw_private FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE mw_private.environment (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 environment text NOT NULL CHECK(environment IN ('dev','production')),
 instance_id uuid NOT NULL UNIQUE
);
INSERT INTO mw_private.environment VALUES (true, 'dev', '3a6a67bc-5ce6-46a4-af72-e6ab78800e49');
CREATE FUNCTION public.mw_environment_identity() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = mw_private, pg_temp
AS $$ SELECT jsonb_build_object('environment', environment, 'instanceId', instance_id) FROM mw_private.environment WHERE singleton $$;
REVOKE ALL ON FUNCTION public.mw_environment_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mw_environment_identity() TO service_role;
