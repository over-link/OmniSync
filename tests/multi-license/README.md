# Multi-license regression tests

Throwaway-schema tests for the multi-company work (chunks 2, 3a, 3b, 3c — see
docs/multi-tenant-architecture.md). They create a scratch schema in the database
named by DATABASE_URL (the schema is dropped at the end, the live tables are never
touched), start the app with all outbound HTTP faked, and forge sessions.

Run them ONE AT A TIME (they share ports and scratch-schema names; running several at once makes them fail).
Run from the repo root (each takes about 1-3 minutes — most of it database round-trips):

    node tests/multi-license/c2test.js     # old (deployed) vs new code on 60 requests + 24 two-license checks
    node tests/multi-license/c3test.js     # per-license slots, expiry phases, suspension, sync pause (33 checks)
    node tests/multi-license/c3btest.js    # per-license sync switches, platform pause, scheduling (32)
    node tests/multi-license/c3ctest.js    # catch-up after a pause (32; no network, in-process)
    node tests/multi-license/c4test.js     # license drop-down API (greyed licenses) + operator console routes (60)
    node tests/multi-license/c5test.js     # one ACC project, one active Revizto project: the guard, migration backfill, expiry/archive release (34)
    node tests/multi-license/c6test.js     # row-level security: the real restricted role, policies, leaks, self-test (50; in-process)
    node tests/multi-license/c7test.js     # operator console actions: rename / timezone / owner, remove admin, resend invite, delete license / company (58; email faked)
    node tests/multi-license/c8test.js     # primary operator, adding / removing operators, the operator audit trail (39; email faked)
    node tests/multi-license/operatorfiltertest.js  # operator console search / company / status / date-range filters (49; pure logic, no database)
    node tests/multi-license/perftest.js   # Issues-page speed-up: parallel page reads, the 30 s shared read cache, batched clean-up (25; in-process, no network)

Run the whole set twice for chunk 6: normally, and with RLS_MODE=on (and DB_POOL_MAX=3, because two servers share
Supabase's 15 connections):  DB_POOL_MAX=3 RLS_MODE=on node tests/multi-license/c2test.js
With RLS on they also fail if the restricted role was refused a query ("[rls] The restricted role was refused" in the
server log). The first run creates the database-level role app_rls (login-less, no bypass); scratch schemas are dropped.

c2test.js compares the working tree against a baseline commit — by default 9c5afd0
(the version live on Render when this was written). Use BASELINE=<commit> to change it.

They need the local .env (DATABASE_URL, SESSION_SECRET). Always run with polling off
(the tests set POLL_ENABLED=false themselves). If a run is killed, drop any leftover
schema whose name starts with tst_.
