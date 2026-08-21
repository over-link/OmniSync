-- Revizto <-> ACC Sync — schema
-- Run once against your Postgres instance (Supabase/Neon/etc).
-- Replaces the old app's local JSON files (revizto-tokens.json, syncMap.json)
-- and in-memory token store with durable, multi-user storage.
--
-- MIGRATION PATTERN: CREATE TABLE IF NOT EXISTS only creates a table the
-- FIRST time — it silently does nothing to a table that already exists,
-- so adding a column here later does NOT retroactively add it to your
-- live database (this bit us twice already). From now on, new columns on
-- existing tables are added via explicit ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS statements below the CREATE TABLE block, which ARE safe to re-run.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Role: 'admin' or 'standard'. Gates project setup/mapping and team
-- management (not personal ACC/Revizto connections, which stay open to
-- everyone). The first person to ever sign in is auto-promoted to admin
-- (see routes/auth.js); promote/demote others via the Team page, or
-- directly: UPDATE users SET role = 'admin' WHERE email = '...';
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'standard';

-- Log of team invites — the actual access grant is just the users row
-- existing with a role; this table is a record of who invited whom and
-- whether an email was actually sent (vs. just added to the list).
CREATE TABLE IF NOT EXISTS invites (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'standard',
  invited_by    INTEGER REFERENCES users(id),
  email_sent    BOOLEAN NOT NULL DEFAULT false,
  email_error   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per user holding their Autodesk/APS 3-legged OAuth tokens.
CREATE TABLE IF NOT EXISTS acc_tokens (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token      TEXT NOT NULL,
  refresh_token     TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  autodesk_user_id  TEXT,
  autodesk_email    TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The user's selected ACC hub — mirrors revizto_tokens.license_id (below):
-- a per-user "current context" selection that scopes which ACC projects
-- show up in the "add/modify project pairing" dropdown, the same way
-- license_id scopes the Revizto project dropdown. Nullable — not required
-- just to connect ACC, same reasoning as license_id.
ALTER TABLE acc_tokens ADD COLUMN IF NOT EXISTS default_hub_id TEXT;

-- One row per user holding their Revizto OAuth tokens.
-- access token: ~1hr life. refresh token: ~1 month life (per Revizto docs;
-- confirm with Revizto whether this is a hard expiry or resets on use).
CREATE TABLE IF NOT EXISTS revizto_tokens (
  user_id             INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token        TEXT NOT NULL,
  refresh_token       TEXT NOT NULL,
  access_expires_at   TIMESTAMPTZ NOT NULL,
  refresh_expires_at  TIMESTAMPTZ NOT NULL,
  -- The region the access code was issued from (e.g. 'virginia', 'ireland').
  -- Needed on every subsequent call, including refresh — was previously
  -- hardcoded to 'virginia' everywhere, which breaks for non-US regions.
  region              TEXT NOT NULL DEFAULT 'virginia',
  -- Needed to call /project/list/{licenseUuid}/paged (the "browse my
  -- Revizto projects" dropdown). Despite the column name, this stores the
  -- license UUID (not the numeric license id) — that's what the documented
  -- endpoint actually requires. Selected via dropdown once the user
  -- connects; nullable because it's not required just to connect.
  license_id          TEXT,
  -- A license has its own region (from /user/licenses), which can differ
  -- from the region the user's own account/token was issued in. Project
  -- calls need to use the LICENSE's region, not assume it matches the
  -- account's — captured at selection time from the dropdown.
  license_region       TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A "project" ties one Revizto project to one ACC project.
-- Multiple rows here is what lets this scale to multiple teams/customers later.
CREATE TABLE IF NOT EXISTS projects (
  id                      SERIAL PRIMARY KEY,
  name                    TEXT NOT NULL,
  revizto_project_uuid    TEXT NOT NULL,
  revizto_region          TEXT NOT NULL DEFAULT 'virginia',
  acc_hub_id              TEXT NOT NULL,
  acc_project_id          TEXT NOT NULL,
  acc_default_subtype_id  TEXT,
  webhook_id              TEXT,
  -- Automated (cron/webhook) syncs have no logged-in user, so they act
  -- using this user's stored tokens. Must be someone who has connected
  -- both ACC and Revizto. On-demand syncs triggered from the UI instead
  -- use whichever user clicked the button.
  owner_user_id           INTEGER REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tracks which Revizto issue is linked to which ACC issue, per project.
CREATE TABLE IF NOT EXISTS sync_map (
  id                SERIAL PRIMARY KEY,
  project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revizto_issue_id  TEXT NOT NULL,
  acc_issue_id      TEXT NOT NULL,
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, revizto_issue_id),
  UNIQUE (project_id, acc_issue_id)
);

-- Email -> Autodesk user ID mapping, per project (replaces REVIZTO_USER_MAP in .env).
CREATE TABLE IF NOT EXISTS user_map (
  id               SERIAL PRIMARY KEY,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email            TEXT NOT NULL,
  acc_autodesk_id  TEXT NOT NULL,
  UNIQUE (project_id, email)
);

CREATE INDEX IF NOT EXISTS idx_sync_map_project ON sync_map(project_id);
CREATE INDEX IF NOT EXISTS idx_user_map_project ON user_map(project_id);

-- Tracks the most recent sync error per linked issue, so the Setup page
-- dashboard can show a real "# failed" count instead of errors only
-- flashing in the UI momentarily when a push happens. NULL = last attempt
-- succeeded (or never failed).
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

-- Numeric Revizto project ID (distinct from the UUID used everywhere
-- else) — needed specifically for GET /issue/{uuid}/comments/date, which
-- oddly wants this instead of the UUID. NULL for projects created before
-- this was added; comment sync won't work for those until re-saved.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS revizto_project_id INTEGER;

-- Tracks the last comment UUID we've already pushed to ACC for each
-- linked issue, so the 2-minute auto-resync doesn't re-post the same
-- "latest comment" over and over.
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_pushed_comment_uuid TEXT;

-- Tracks the last ACC comment ID we've already pulled into Revizto, for
-- the polling-based comment sync (no webhook event exists for comments —
-- confirmed from Autodesk's own Supported Events Reference, which only
-- lists issue.created/updated/deleted/restored/unlinked, nothing
-- comment-specific).
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_pulled_acc_comment_id TEXT;

-- Tracks the last ACC attachment ID we've already pulled into Revizto,
-- for the polling-based attachment sync (ACC attachment events aren't
-- confirmed to fire the issue.updated webhook, so this uses the same
-- polling approach already proven out for comments, not the webhook).
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_pulled_acc_attachment_id TEXT;

-- Tracks the ACC "Revizto Status" secondary field's option ID as of the
-- last webhook delivery we processed for this issue — lets
-- syncService._resolveReviztoStatusFromAcc tell WHICH ACC field actually
-- just changed (the webhook payload itself carries no field-level diff),
-- since an unambiguous primary-status change should win outright, but
-- only when the secondary field itself DIDN'T also just change — without
-- this, an unambiguous-but-unrelated current primary status was
-- incorrectly short-circuiting a genuine secondary-field change.
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_acc_secondary_option_id TEXT;

-- Tracks whether the Revizto markup preview image has already been
-- attached to the linked ACC issue, so it doesn't re-upload the same
-- image every 2-minute cycle.
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS markup_uploaded BOOLEAN NOT NULL DEFAULT false;

-- Tracks WHICH markup comment we last uploaded (by UUID), not just
-- whether we ever uploaded one — markup can be redrawn/updated over
-- time, and each update is its own new "markup" comment, so this needs
-- the same "latest wins, re-check each cycle" treatment as text comments.
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_markup_comment_uuid TEXT;

-- Admin-configured status mapping, per project. "To do"/"Completed"
-- category statuses (see reviztoService.toAccIssue) auto-map without
-- needing a row here; everything else falls back to ACC "Draft" as a
-- deliberate safeguard when no row exists for a given Revizto status.
CREATE TABLE IF NOT EXISTS status_map (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revizto_status  TEXT NOT NULL,
  acc_status      TEXT NOT NULL,
  UNIQUE (project_id, revizto_status)
);

-- Workflow-scoped status mapping: a project can have multiple Revizto
-- workflows, and two different workflows can each define a status with
-- the same NAME but a different UUID — the original UNIQUE(project_id,
-- revizto_status) above collapsed those into one shared mapping, which is
-- wrong whenever workflows disagree on what a same-named status should
-- become in ACC. workflow_uuid defaults to '' for every row inserted
-- before this column existed, and lookups check the issue's real workflow
-- UUID first, falling back to the '' bucket — so pre-migration mappings
-- keep working instead of silently disappearing (see fieldMapping.
-- getStatusMap/reviztoService.toAccIssue).
ALTER TABLE status_map ADD COLUMN IF NOT EXISTS workflow_uuid TEXT NOT NULL DEFAULT '';
ALTER TABLE status_map DROP CONSTRAINT IF EXISTS status_map_project_id_revizto_status_key;
-- Explicit pg_constraint check, not "EXCEPTION WHEN duplicate_object" —
-- an already-existing constraint from a prior migrate run raises
-- duplicate_table (42P07), not duplicate_object, so that exception class
-- didn't actually catch a re-run (confirmed by a real "already exists"
-- failure on a second `npm run migrate`). Checking pg_constraint directly
-- sidesteps the SQLSTATE class question entirely.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'status_map_project_workflow_status_key') THEN
    ALTER TABLE status_map ADD CONSTRAINT status_map_project_workflow_status_key UNIQUE (project_id, workflow_uuid, revizto_status);
  END IF;
END $$;

-- Secondary ACC mapping: an admin-created ACC list/custom-field ("Revizto
-- Status", discovered by title the same way Grid Intersection/Room/Issue
-- Priority already are) whose option this Revizto status maps to. Lets
-- the ACC->Revizto direction resolve precisely even when several custom
-- statuses in one workflow share the same coarse primary ACC status (see
-- syncService.handleAccWebhook) — nullable, since most statuses don't
-- need this precision and can rely on the primary mapping alone.
ALTER TABLE status_map ADD COLUMN IF NOT EXISTS acc_custom_status_option_id TEXT;

-- Admin-configured issue-type mapping, per project. `revizto_type` is
-- matched against whatever field ends up confirmed as Revizto's actual
-- type/stamp-category field (see getIssuesBoard's unwrap attempts —
-- still unverified as of this table's creation). Falls back to the
-- hardcoded title-keyword matching in reviztoService when no row matches.
CREATE TABLE IF NOT EXISTS type_map (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revizto_type    TEXT NOT NULL,
  acc_subtype_id  TEXT NOT NULL,
  UNIQUE (project_id, revizto_type)
);

-- Admin-configured REVERSE status mapping (ACC status -> Revizto status),
-- per project — the ACC->Revizto direction previously had no admin
-- override at all, only the hardcoded guess in reviztoService.
-- mapStatusFromAcc (e.g. "pending" -> "Open", which isn't always what an
-- admin actually wants). acc_status is one of ACC's fixed 9 enum values;
-- unmapped falls back to that same hardcoded guess, flagged on the Setup
-- page rather than silently applied.
CREATE TABLE IF NOT EXISTS acc_status_map (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  acc_status      TEXT NOT NULL,
  revizto_status  TEXT NOT NULL,
  UNIQUE (project_id, acc_status)
);

-- Whether auto-sync-by-filter is on for a project (see auto_sync_filters
-- below). Off by default — this is an opt-in convenience on top of the
-- existing manual "select issues to link" flow, not a replacement for it.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_sync_enabled BOOLEAN NOT NULL DEFAULT false;

-- Admin-configured auto-sync filter criteria, per project — same fields
-- as the Issues page's own filters (status, stampCategory, issueType,
-- stamp, assignee, assigneeCompany, priority, isClash, tags, level, zone,
-- room). One row per (field, value) pair; multiple values for the same
-- field are OR'd together, different fields are AND'd together — same
-- semantics as the Issues page's own filter combination. Every
-- currently-unlinked issue matching all configured fields gets
-- automatically linked+pushed on the same 2-minute poll cycle as the
-- existing auto-resync (see syncService.autoLinkMatchingIssues).
CREATE TABLE IF NOT EXISTS auto_sync_filters (
  id          SERIAL PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL,
  UNIQUE (project_id, field, value)
);
CREATE INDEX IF NOT EXISTS idx_auto_sync_filters_project ON auto_sync_filters(project_id);

-- Whether any signed-in user (not just admins) can manually unlink an
-- issue from the Issues page — admin-controlled opt-in, off by default.
-- "Unlink" only deletes the sync_map row (this app's own bookkeeping of
-- which Revizto issue corresponds to which ACC issue); it never deletes
-- the actual issue in either Revizto or ACC. Exists mainly for recovering
-- from a broken link (e.g. the ACC issue was deleted outside this app)
-- without needing direct DB access — see syncService.pushIssueToAcc's
-- own automatic 404 self-heal for the common case; this is the manual
-- escape hatch for anything that doesn't self-heal.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS allow_manual_unlink BOOLEAN NOT NULL DEFAULT false;

-- Denormalized ACC project display name, captured at pairing save time —
-- lets the Setup page's locked pairing row always show a real name on
-- both sides without depending on the currently-selected ACC hub's live
-- project list still containing it (e.g. after switching hubs). `name`
-- (above) now doubles as the Revizto side's display name — the Setup
-- page auto-fills it from the selected Revizto project's own title
-- instead of asking for a separate nickname.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS acc_project_name TEXT;

-- File attachment sync (Revizto -> ACC, real attachments like photos/PDFs —
-- as opposed to markup updates, already tracked separately via
-- last_markup_comment_uuid above). Same "latest only" policy as markup, so
-- just one tracked value each, plus two ping-pong guards since this and
-- the existing ACC->Revizto attachment poll (pollAccAttachmentsForProject)
-- now both touch attachments and could otherwise re-import each other's
-- pushes forever:
--   last_pushed_file_comment_uuid: the Revizto file comment we last pushed
--     to ACC — skip re-pushing the same one every 2-minute cycle.
--   last_pulled_acc_attachment_comment_uuid: the Revizto comment CREATED
--     by pulling an ACC attachment in (pollAccAttachmentsForProject) — the
--     Revizto->ACC push must recognize and skip this exact comment, or it
--     would push it straight back to ACC as if it were newly added there.
--   last_pushed_file_attachment_acc_id: the ACC attachment CREATED by
--     pushing a Revizto file out — the ACC->Revizto poll must recognize
--     and skip this exact attachment, the mirror-image guard.
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_pushed_file_comment_uuid TEXT;
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_pulled_acc_attachment_comment_uuid TEXT;
ALTER TABLE sync_map ADD COLUMN IF NOT EXISTS last_pushed_file_attachment_acc_id TEXT;

-- connect-pg-simple creates its own "session" table automatically on first run.
