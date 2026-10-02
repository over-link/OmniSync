-- Undoes chunk 1 (the multi-company groundwork in schema.sql): removes ONLY the new
-- tables and columns. Nothing the app reads today is touched, and the app does not
-- use any of this yet, so it is also fine to leave in place. Run it by hand
-- (Supabase SQL editor) if you ever want it gone. Order matters.
BEGIN;
ALTER TABLE projects DROP COLUMN IF EXISTS tenant_license_id;
ALTER TABLE projects DROP COLUMN IF EXISTS tenant_id;
ALTER TABLE users DROP COLUMN IF EXISTS current_license_id;
ALTER TABLE users DROP COLUMN IF EXISTS is_operator;
DROP TABLE IF EXISTS license_members;
DROP TABLE IF EXISTS tenant_licenses;
DROP TABLE IF EXISTS revizto_licenses;
DROP TABLE IF EXISTS tenants;
COMMIT;
