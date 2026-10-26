-- Local stand-ins for Supabase API roles (worst case: legacy default privileges
-- that grant anon/authenticated everything on new public tables and functions).
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;

CREATE SCHEMA qa;
GRANT USAGE ON SCHEMA qa TO PUBLIC;
CREATE TABLE qa.results (id serial PRIMARY KEY, name text NOT NULL, ok boolean NOT NULL);
CREATE FUNCTION qa.check(n text, c boolean) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = qa, pg_temp AS $$
BEGIN INSERT INTO qa.results(name, ok) VALUES (n, coalesce(c, false)); END $$;
-- Runs SQL as the CURRENT role (invoker); returns NULL on success or the error text.
CREATE FUNCTION qa.err(s text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN EXECUTE s; RETURN NULL; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA qa TO PUBLIC;
