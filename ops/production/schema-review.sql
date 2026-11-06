-- Read-only inventory for a reviewed migration plan. No customer data.
BEGIN READ ONLY;
SELECT table_name,column_name,data_type,is_nullable,column_default
FROM information_schema.columns WHERE table_schema='public'
ORDER BY table_name,ordinal_position;
SELECT tablename,policyname,roles,cmd,qual,with_check
FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname;
SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r';
SELECT routine_name FROM information_schema.routines WHERE routine_schema='public' ORDER BY routine_name;
SELECT grantee,table_name,privilege_type FROM information_schema.table_privileges
WHERE table_schema='public' AND grantee IN ('anon','authenticated','service_role')
ORDER BY table_name,grantee,privilege_type;
COMMIT;
