# Revizto ↔ ACC Sync (v2 — multi-user, DB-backed)

Rebuild of the original prototype, fixing the "only works on my laptop" problem
by moving all tokens and sync state out of local files/memory and into a
shared Postgres database, and moving auth from a single hardcoded connection
to **per-user OAuth** for both Autodesk and Revizto.

## What changed from the original

| Old | New | Why |
|---|---|---|
| ACC tokens in an in-memory JS object | Postgres, per user | Survives restarts, works from any machine |
| `revizto-tokens.json` on disk | Postgres, per user | Same |
| `syncMap.json` on disk | `sync_map` table | Same, queryable |
| Single hardcoded `.env` connection | Per-user OAuth (ACC) + per-user access-code connect (Revizto) | Multiple team members, real attribution, sets up multi-tenant later |
| ngrok tunnel for webhooks | Real hosted URL (Render/Railway) | Stable, doesn't break on restart |
| Secrets in `.env` shipped in a zip | Secrets only in host environment variables | Don't repeat that mistake — rotate the old ones |

## Prerequisites

- Node.js 18+
- A Postgres database (Supabase or Neon both have usable free tiers)
- An APS (Autodesk Platform Services) app — client ID + secret from aps.autodesk.com
- A Revizto workspace with API access (Revizto+ license) — no separate app registration needed; auth is per-user via access code (see below)

## Setup

```bash
npm install
cp .env.example .env
# fill in DATABASE_URL, SESSION_SECRET, APS_CLIENT_ID, APS_CLIENT_SECRET, APS_CALLBACK_URL
npm run migrate   # creates all tables
npm start
```

Open http://localhost:3000

## Connecting accounts

1. **Sign in** with your email (prototype-level identity only — no password.
   Replace with real auth like Clerk/Auth0 before onboarding paying customers.)
2. **Connect ACC** — standard OAuth redirect, click and log in with Autodesk.
3. **Connect Revizto** — Revizto's flow doesn't support redirecting back to
   us, so it's a copy/paste step:
   - Click "Connect Revizto" — opens `https://ws.revizto.com/login?request=accessCode` in a new tab
   - Sign in there, copy the code shown (valid **15 minutes**)
   - Paste it into the app and submit

Revizto **refresh tokens expire monthly** (per their docs) — every connected
user will need to repeat the Revizto reconnect step about once a month. This
isn't a bug; it's how their API works. Consider adding an email/Slack
reminder before expiry once this goes beyond a prototype.

## Pages

- **`/account`** — sign in, connect your own ACC/Revizto (open to everyone —
  personal, per-user, doesn't affect anyone else). Everyone needs both
  connected to view/sync on the Issues page.
- **`/setup`** — your Revizto **license** selection (needed to browse your
  Revizto projects when adding a pairing — moved here from Account since
  only admins use it), project mapping, and field mapping. **Admin-only.**
- **`/team`** — invite people, set roles. **Admin-only.**
- **`/issues`** — the working view: pick a project, filter, see Revizto
  issues on the left and their linked ACC counterpart on the right (synced
  rows highlighted green), select unlinked issues and link them. Open to
  Standard and Admin alike.
- **`/logs`** ("Log files") — the audit trail: every field change,
  comment, attachment, link/unlink, and error, with who it's attributed
  to and when. See "Audit log" below. Open to Standard and Admin alike.
- **Analytics** — placeholder nav link, not built yet.

Navigation is a shared left sidebar (`public/js/nav.js`), loaded first on
every page — it fetches auth state once, renders links based on role, and
redirects non-admins/signed-out visitors away from `/setup` and `/team`.
That redirect is a UX convenience only; the real security boundary is
`requireAdmin` on the API routes themselves.

## Team & roles

Two roles: `admin`, `standard` (a column on `users`, not per-project — fine
for a small team, revisit if you end up with genuinely different admins per
customer later). Admin can manage project setup and team; Standard can view/
sync issues and connect their own ACC/Revizto.

**The first person to ever sign in is auto-promoted to admin.** After that,
existing admins manage roles from the Team page, or directly:
```sql
UPDATE users SET role = 'admin' WHERE email = 'someone@company.com';
```

**Inviting**: two ways, both on the Team page. "Add someone" grants
access immediately (their `users` row is created/updated with that
role) — the field accepts **one email or many at once**: paste a whole
list (one per line, or comma/semicolon-separated, however it comes out
of an email client or spreadsheet) and each one is added in turn, with a
per-email result line for anything that fails. A notification email is
always attempted too via generic SMTP (`SMTP_HOST`/`SMTP_USER`/
`SMTP_PASS` in `.env`; works with Gmail, SendGrid, Postmark, Resend's
SMTP relay, or your own mail server — not locked to one vendor, and no
separate opt-in checkbox — "Add" is the one action). If SMTP isn't
configured, "Add" still grants access fully; it just tells you the email
wasn't sent rather than silently failing. "Copy invite
link" instead generates one shareable, reusable link per role that you
send out yourself (email, Slack, however) to a whole group at once — see
"Invite links" below for the full mechanism, including how this also
closed a real open-signup gap.

**Migration needed**: `users.role` and the `invites` log table are new
(added via idempotent `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS`, per the
migration pattern noted at the top of `schema.sql`). Run `npm run migrate`
after pulling this update. Also run `npm install` — `nodemailer` is a new
dependency.

### "Last login" / "Latest sync activity" columns — who's actually using this

Two more columns on the Team page, added so an admin can tell who's
actively using the app vs. dormant, without confusing either signal with
something that isn't real usage:

- **Last login** — `users.last_login_at`, set on every successful
  `/auth/identify` (the app's own sign-in). Deliberately **not** reusing
  `acc_tokens`' refresh timestamp for this — `pollService.
  keepAccConnectionsAlive` touches that daily for every connected user
  regardless of whether they've done anything, so it isn't a valid proxy
  for real activity (see "Autodesk revokes an idle refresh token" above).
- **Latest sync activity** — not a stored column at all; read live from
  `audit_log` (`MAX(created_at) WHERE attributed_email = <this user's
  email>`, case-insensitive). Since `audit_log` only ever records a REAL
  action (a field change, comment, attachment, link/unlink, or error)
  traced back to a specific person — not a routine no-op resync where
  nothing actually changed — this single column already captures "when
  did something this person did last actually happen," without needing a
  separate mechanism to track connection usage on its own.

Both show "Never"/"None yet" until a user's first real login or first
piece of attributed activity after this shipped — there's no retroactive
backfill, since neither signal existed before now.

**Migration needed**: `users.last_login_at`. Run `npm run migrate`.

### Invite links — shareable, reusable, and now required to sign up at all

Previously, adding someone meant the admin typing their exact email into
the "Add someone" form (still there, still works, unchanged) — fine for
one person at a time, more friction for onboarding a whole group at
once. The Team page now also has a **"Copy invite link"** section: pick
a role, click, and the link (`/account?invite=<code>`) is copied to your
clipboard — paste it into an email or chat message yourself and send it
to as many people as you want. It's a **reusable, shared** link, not a
single-use per-person token: the same code works for everyone it's sent
to, matching "email it to a group" rather than "generate N individual
invites." `POST /api/team/invite-links` reuses an existing active link
for that role if one already exists rather than piling up duplicates
every time the button is clicked; **Revoke** invalidates one (e.g. if it
leaked somewhere it shouldn't have) without deleting its row, and the
next "Copy invite link" click for that role then generates a fresh code.

**Closes a real, previously-open gap**: before this, `/auth/identify`
had no access control at all — anyone who found the app's URL could type
in any email and get a `standard`-role account immediately, no invite
needed (this was called out as an intentional, acceptable gap in "Known
limitations" for a small trusted team, but stops being fine once there's
a real invite mechanism to lean on instead). Now, creating a **brand
new** account requires a valid, non-revoked code from `invite_links`. Two
exemptions, both necessary for the app to still be usable:
- **The very first user ever** (empty `users` table) still needs no
  code — bootstraps as admin exactly as before, since nobody could ever
  generate the first invite link otherwise.
- **An existing user signing back in** never needs a code — this only
  gates the creation of a brand-new account, not returning to one that
  already exists. Same for anyone the admin adds directly via the "Add
  someone" form, which is a separate, already-`requireAdmin`-gated path
  untouched by this change.

**Migration needed**: new `invite_links` table (`id`, `code`, `role`,
`created_by`, `created_at`, `revoked_at`). Run `npm run migrate`.

### Connections gate — every page except My Connections requires both accounts connected

`public/js/nav.js` (loaded first on every page) now redirects to
`/account` from anywhere else — Issues, Setup, Team, Log files, all of
it — unless the signed-in user has **both** ACC and Revizto connected.
Applies to everyone, admins included, no carve-out. This closes the gap
where a freshly invited person (via the link above) could land on, say,
the Issues page immediately after signing in, before ever connecting
either account, and just see an empty/broken board with no clear next
step — now they're kept on My Connections until both are actually done.

This is a **client-side UX redirect, not a new server-side security
boundary** — same caveat as the existing admin-only-path redirect it
sits next to. The app's other API routes don't currently reject requests
from an unconnected user server-side; this only changes what page you
land on. `requireAdmin` remains the real enforcement for admin-only
routes, unchanged by this.

No migration needed — reads the same `acc`/`revizto` connection status
`/auth/me` already returned before this.

## Field names (confirmed from a real raw issue response)

A real raw issue from Revizto's `issue-filter/filter` endpoint revealed
several fields that turned out different from what docs examples alone
suggested — this is the actual, verified shape now in use:

| Concept | Field | Notes |
|---|---|---|
| Status (display) | `customStatusName` | Plain string (e.g. "In progress") — Revizto returns this ready-to-use, right alongside the UUID version. No resolution needed. |
| Status (write) | `customStatus.value` | The UUID — only needed when *writing* a new status back (see `updateIssueStatus`'s diff-comment mechanism), not for reading/display. |
| Issue type | `customTypeName` | Plain string (e.g. "Standard issue"), same pattern as status. `customType.value` is the UUID counterpart — don't use it for display/mapping. |
| Stamp abbreviation | `stampAbbr` | **Not** `stamp` — that field doesn't exist on the real payload. This was an actual bug (empty stamp/stamp-category filters) until caught against real data. |
| Stamp category | *(derived)* | Not a direct field — resolved by looking up `stampAbbr` against the project's stamp templates (`getStampPresets` + `buildStampCategoryLookup`). |
| Assignee | `assignee.value` | Confirmed to be a bare email address, not a name. **Resolved to a display name** via `GET /license/{licenseUuid}/team` (the license's member list, which includes `fullname`) — uses the *viewing user's own* saved license as the context, assuming the project was set up under that same license (true for the normal setup flow). Falls back to showing the raw email if the person isn't found in that license's member list (e.g. assigned but not a member, or genuinely a different license). |
| Level / zone / room / area / grid | `clashAndLocationFields.level` / `.zone` / etc. | `array[string]`. **Not returned by default** — even with `sendFullIssueData: true`, this object comes back `undefined` unless the request also includes `additionalFields: ['appendClashAndLocationFields']`. Confirmed by testing: the field is genuinely documented under this same `issue-filter/filter` endpoint, just gated behind that extra param. |

**Lesson learned twice over on this feature**: a docs *example* (like the
stamp-template response) doesn't guarantee the same field behaves
identically elsewhere — `customType` looked like a plain string in the
stamp-template docs, but the actual issue's own `customType` field is a
UUID with a separate plain-string sibling (`customTypeName`). Real sample
data settled it where docs examples alone didn't.

## Sync health: stats vs. warnings (different audiences, split on purpose)

- **Stats** (Revizto count, ACC count, linked/synced, errors) — a compact
  pill strip next to the project picker on the **Issues page**, visible to
  any signed-in user. `GET /api/projects/:id/stats`, `requireLogin` (not
  admin-gated) — same endpoint a future Analytics page would reuse.
- **Mapping warnings** (in-use statuses/stamps with no configured mapping)
  — a dedicated card at the **top of the Setup page**, above everything
  else, so an admin sees it immediately on landing. `GET
  /api/projects/:id/mapping-warnings`, `requireAdmin` — this is an action
  item for whoever manages mapping, not a general-audience stat.

Both pull from `syncService.getSyncStats` / `fieldMapping.getUnmappedFields`
respectively — split into separate functions specifically so the general
stats don't carry an admin-only dependency.

**Migration needed**: `sync_map.last_error`/`last_error_at` columns
(idempotent `ALTER TABLE`). Run `npm run migrate`.

## Audit log ("Log files" page) — durable, queryable "who did what, when"

Before this, the only record of a sync event was `sync_map.last_error`
(overwritten by the next event, no history) and Render's own server
logs — ephemeral, unstructured, and gone once the platform rotates them
out. Added specifically so "why does issue #47 look wrong" can be
answered with a query instead of digging through logs, and so there's a
real trail to point to for data-security/auditability purposes.

**One row per meaningful sync event** — a field change (with old/new
values), a comment, an attachment, a link/unlink, or an error — written
by `services/auditLog.js` to a new `audit_log` table. Every write goes
through `syncService._audit`, a thin wrapper that swallows logging
failures so a DB hiccup while writing an audit row never takes down the
actual sync work it's describing.

**Field-change rows reuse the same attribution work already built for
both directions**, rather than being a separate mechanism:
- **Revizto → ACC** (phase 2): `pushIssueToAcc` already diffs the current
  Revizto field values against `sync_map.last_synced_revizto_fields` to
  decide whether to attribute the push to a specific person (see
  "Field-change attribution (Revizto → ACC), phase 2" above) — the same
  diff is what gets logged, one row per changed field, old value and new
  value both captured.
- **ACC → Revizto** (phase 1): each of the six `reviztoService.
  updateIssue*` functions (status/assignee/watchers/priority/deadline/
  title) now returns `{ ok: true, diff }` on a real write instead of just
  a bare truthy/falsy result — `diff` is the exact `{ fieldName: { old,
  new } }` shape already posted to Revizto as a diff comment (see
  `_postDiffComment`), so `handleAccWebhook` logs straight from it via
  `_auditFieldChangeFromDiff` rather than recomputing anything. This was
  a non-breaking change: every one of these six functions has exactly one
  caller (`handleAccWebhook`), and none of them inspected the old return
  value for anything beyond truthiness, confirmed by checking every call
  site before changing the shape.

Comments and attachments log from the same points already doing the real
member attribution (`_pushLatestCommentToAcc`, `pollAccCommentsForProject`,
`_pushLatestFileAttachmentToAcc`, `_pushMarkupImageToAcc`,
`pollAccAttachmentsForProject`). Link/unlink log from `recordLink`,
`unlinkIssue` (manual), and `_handlePossibleAccIssueGone` (self-heal, once
the grace period actually expires). Errors log from `recordSyncError`,
the same single funnel every error already goes through — deliberately
**not** instrumenting `clearSyncError`, since it's called unconditionally
on every successful sync regardless of whether there was a prior error,
and would just flood the log with "no error" noise.

**Open to any signed-in user, not admin-gated** (`GET /api/audit-log`,
`requireLogin`) — the `/logs` page ("Log files" in the sidebar) is meant
as a shared, visible trail for the whole team, same access level as the
Issues page, not an admin-only tool. Optionally filtered by project
(`?projectId=`), paginated (`?limit=&offset=`, default 100/page, capped
at 500).

**Migration needed**: new `audit_log` table (`id`, `created_at`,
`project_id`, `revizto_issue_id`, `acc_issue_id`, `direction`, `action`,
`field_name`, `old_value`, `new_value`, `attributed_email`, `outcome`,
`detail`), indexed on `(project_id, created_at)`, `revizto_issue_id`, and
`acc_issue_id`. Run `npm run migrate`.

## Assignee & watchers (re-enabled)

Both push to ACC now, resolved from Revizto's email addresses to Autodesk
user IDs via `makeAssigneeResolver` (Construction Admin API's project
members list, with a manual `user_map` table as an override/fallback).
Watchers reuses the exact same resolver, since ACC's `watchers` field is
also an array of Autodesk user IDs (confirmed from Autodesk's own
create-issues docs example) — same shape as `assignedTo`, just an array.

This was previously disabled after a bug where a Construction Admin API
failure took down the entire issue push; that's fixed (the resolver
catches its own errors and just skips assignee/watchers for that run
rather than failing the whole thing), so it's safe to leave on.

**Still genuinely unconfirmed**: whether Construction Admin API access
requires the same per-account ACC Custom Integration authorization that
Data Management API discovery did. If assignee/watchers start failing
broadly (not just for people missing from the project), that's the first
thing to check — and if you get an answer, corrections/updates welcome.

**ACC→Revizto now also pulls assignee and watchers**, not just status —
resolved from ACC's Autodesk user IDs to emails via the same project
members list used for the forward direction, just inverted. **Unconfirmed
caveat**: the actual Revizto write mechanism (`assignee`/`watchers` diff
comments) is extrapolated from the proven `customStatus` pattern, not
confirmed against real docs — test it and report back if assignee/watcher
changes in ACC don't actually show up in Revizto, since the diff shape
might need adjusting (e.g., a different field key, or a completely
different endpoint) once we see a real failure response.

## Multi-workflow status fix

Confirmed from real docs (`GET /project/{uuid}/issue-workflow/settings`):
a Revizto project can have **multiple workflows**, and each **issue type**
(not each issue directly) is linked to exactly one workflow via
`workflowUuid`. Each workflow only recognizes a subset of the project's
overall status list — so two different workflows can each define a status
named e.g. "In progress" with two different UUIDs.

The old code built one flat `{name: uuid}` map from the project-wide
status list, so if two workflows shared a status name, whichever one got
processed last silently won — and that could easily be the wrong
workflow's version for the specific issue being updated, producing errors
like `"The workflow with uuid X does not connected to status with uuid Y"`.

Fixed: status resolution now goes issue → its `customType` → that type's
`workflowUuid` → that workflow's own valid status list, and only matches
a status name within that set. Falls back to a project-wide name match
if the type/workflow lookup doesn't resolve (e.g. issue has no type set),
rather than refusing outright.

**Later hardened further** (`reviztoService._resolveStatusUuidForIssue`):
that project-wide fallback was still a latent risk once a workflow *is*
successfully resolved but the target name isn't one of its own statuses —
it could match a same-named status belonging to an unrelated workflow.
Now the project-wide fallback only runs when the workflow itself couldn't
be resolved at all; once a workflow is known, only a status that actually
belongs to it is accepted, full stop. Same underlying gap is what the
"Status mapping — per workflow, both directions" section below is about,
one layer up (the *admin-configured mapping*, not just this UUID
resolution).

## Markup image upload (Revizto → ACC) — confirmed working

Uploads the actual **markup image with drawings** as a file attachment on
the linked ACC issue — not the issue's own top-level `preview` field
(which is confirmed from real docs to be just the base viewpoint, no
annotations). The real drawings-included image lives on Revizto's
**"Markup update" comment type** specifically — confirmed from real docs,
its `preview` field is explicitly described as including "all drawings
that were added to it," unlike the issue-level `preview`. Falls back to
the issue-level preview only if no markup comment exists yet, so
something still gets attached rather than nothing.

Tracked by the markup comment's own UUID (`sync_map.last_markup_comment_uuid`),
not a one-time boolean — markup can be redrawn/updated over time, each
update creates a new "markup" comment, and this re-checks for a newer one
each sync cycle so the ACC attachment stays current rather than freezing
at whatever was drawn first.

There's no "pinned/hero image at the top of an issue" concept found in
ACC's API — the closest achievable approximation is being the first
attachment uploaded, not a distinct pinned-preview feature.

**Two real bugs found and fixed during testing, both worth knowing about
if this ever needs revisiting:**
1. The official Autodesk tutorial this was built from documents the
   endpoint under `issues/v1/projects/{id}/attachments` — but that path
   consistently returned "resource does not exist" (a 404-style error
   suggesting the whole route wasn't available on this account, possibly
   because the tutorial is filed under "Forma Issues (beta)" — a
   different/beta product surface). The actual working path for this
   project is `construction/issues/v1/projects/{id}/attachments` —
   consistent with every other Issues API call in this file.
2. The request body must **not** include `fileSize` or `fileType` —
   Autodesk's own docs example for the *GET* response includes them, but
   the *creation* payload schema rejects them outright
   (`"body.attachments[0].fileSize" is not allowed"`). Confirmed by
   testing, not guessed.

**Migration needed**: `sync_map.markup_uploaded`,
`sync_map.last_markup_comment_uuid` (idempotent `ALTER TABLE`). Run
`npm run migrate`.

## File attachment sync (Revizto → ACC) — confirmed working

Separate from markup image upload above: a Revizto issue's real
**attachments** (photos, PDFs, etc. — added as a plain "file" comment, not
a markup update) now also sync to ACC, using `reviztoService.
findLatestFileComment` + `syncService._pushLatestFileAttachmentToAcc`.
**Latest only** — same policy as markup and comments, deliberately not
"sync every attachment," so this stays symmetric with those rather than
introducing a different rule for this one field. Tracked via
`sync_map.last_pushed_file_comment_uuid` (a single value, same shape as
`last_markup_comment_uuid`).

**Whether this is the real file or a lossy re-render depends on file
type — confirmed by real testing, not assumed.** Revizto's API only ever
exposes a `preview.original` URL for a file comment (its own schema calls
this "a link to the issue markup picture," despite applying to every file
type, image or not — there is no separate "download the original"
endpoint anywhere in Revizto's v5 API):
- **Non-image files (PDF, etc.): byte-identical to the real upload.**
  Confirmed on a real 317,414-byte PDF — `preview.original`'s
  `Content-Type` and `Content-Length` matched the upload exactly.
- **Large photos: genuinely re-compressed.** Confirmed on a real
  8,970,240-byte JPG — `preview.original` came back as 3,176,687 bytes,
  same image, smaller file. Revizto's own pipeline does this, not
  anything on this app's side; there's no way to get the untouched bytes
  back for a large image specifically.

Reuses the exact same upload pipeline as markup image upload
(`accService.attachFileToIssue` — renamed from `attachImageToIssue` once
it started handling real non-image files too; the mechanics never
actually cared about file type).

### Attachment record attribution — separate from the upload pipeline's own access needs

Reported gap: the real uploader's name showed correctly in the issue's
Activity feed (the "Attachment added via Revizto sync by `<name>`" note
comment — plain text, so it displays correctly regardless of which
connection actually posted it) but **not** on the attachment's own
details, e.g. the "uploaded by" shown when hovering an attachment chip in
ACC's Attachments panel.

Likely root cause (the fix below is confirmed working; the exact
mechanism wasn't independently verified against logs): `accService.
attachFileToIssue` is a 4-step pipeline (get the project's root folder →
create Docs storage → upload the file's bytes → attach the storage object
to the issue as a Construction Issues attachment record — this last step
is what ACC's own per-attachment "uploaded by" metadata is read from). It
used to run as a single all-or-nothing call under one identity: if the
real editor's personal ACC connection could authenticate the Issues API
fine but lacked Docs/Data-Management access (a genuinely separate
per-user permission in ACC, distinct from Issues access), steps 1-3 would
fail and the ENTIRE pipeline — including step 4, which never itself
needed Docs access — silently fell back to the default/owner connection,
losing real
attribution on the attachment record even though the separate note
comment (needing only Issues access) still posted fine under the real
editor and displayed their name as plain text regardless.

Fixed: `attachFileToIssue` now takes an optional `attachAsUserId`,
independent from the `userId` used for steps 1-3. Each phase (storage
upload vs. the final attach-to-issue call) tries the real editor's own
connection first and only falls back to the default connection for the
phase that actually failed — a Docs-access gap in steps 1-3 no longer
costs step 4 its own independent shot at the real editor's identity, and
vice versa. Wired into both existing callers, which now pass the resolved
real-editor connection straight through instead of wrapping the whole
call in `_withAccUserFallback` as before: `_pushLatestFileAttachmentToAcc`
(file attachments, attribution already existed but was lost by the
all-or-nothing wrapping) and `_pushMarkupImageToAcc` (markup images,
which previously had **no** attribution resolution at all — always
uploaded as the default connection regardless of who actually drew the
markup, now resolved from the markup comment's own `author`, same as
everywhere else in this file).

**Confirmed fixed by real testing** — a fresh attachment push after this
shipped showed the real editor correctly attributed on the attachment's
own hover details in ACC, not just the note comment.

### Ping-pong guards (this direction now shares attachment traffic with the existing ACC→Revizto poll)

Explicit requirement: an attachment that arrived via ACC→Revizto
(`pollAccAttachmentsForProject`, below) must never bounce straight back to
ACC as if newly added in Revizto, and symmetrically, an attachment this
app just pushed Revizto→ACC must never get re-imported back into Revizto
on the next poll. Two tracking columns close both directions:
- `sync_map.last_pulled_acc_attachment_comment_uuid` — the Revizto
  comment CREATED by pulling an ACC attachment in. If the latest Revizto
  file comment matches this, `_pushLatestFileAttachmentToAcc` marks it
  handled (updates `last_pushed_file_comment_uuid`) without pushing.
- `sync_map.last_pushed_file_attachment_acc_id` — the ACC attachment
  CREATED by pushing a Revizto file out. `pollAccAttachmentsForProject`'s
  existing ping-pong check (previously only a `displayName.startsWith
  ('Revizto Issue ')` pattern match, which only covered markup images —
  a real file push uses the file's actual name, not a recognizable
  pattern) now also checks this directly.

**A real ping-pong round-trip happened once during development**, before
this guard existed: a test push (Revizto→ACC) got auto-polled back into
Revizto by the pre-existing, then-unguarded attachment poller, leaving one
duplicate "file" comment + one "Attachment added via ACC sync" text
comment on a real test issue. Contained to a single round-trip (not a
runaway loop) since the app wasn't left running afterward. **Revizto's API
has no delete-comment endpoint at all** (confirmed against its full
endpoint list — comments can only be added or read, never removed via
the API) — the affected tracking row was manually backfilled to reflect
reality and confirmed the guard now correctly recognizes and skips it, but
the duplicate comment itself is only removable by an admin directly in
Revizto's UI, if it matters enough to bother.

**Migration needed**: `sync_map.last_pushed_file_comment_uuid`,
`sync_map.last_pulled_acc_attachment_comment_uuid`,
`sync_map.last_pushed_file_attachment_acc_id` (idempotent `ALTER TABLE`).
Run `npm run migrate`.

## Comment sync (latest comment only, both directions)

Symmetric with... actually not fully symmetric anymore, see below:

- **Revizto → ACC**: pushed when the issue itself is synced (manual link or
  the 2-minute auto-resync), via `_pushLatestCommentToAcc`. Skips
  diff/file/markup comment types — only text comments push.
- **ACC → Revizto**: **polling-based**, not webhook-based. Confirmed from
  Autodesk's own Supported Events Reference: Construction Issues webhooks
  only cover `issue.created/updated/deleted/restored/unlinked` — there is
  no comment-specific event, so a comment added in ACC never triggers our
  webhook at all (confirmed by real testing — nothing arrives). Instead,
  `pollAccCommentsForProject` runs on the same 2-minute cycle as the
  Revizto→ACC auto-resync, checking each linked issue's ACC comments and
  pushing any new one into Revizto. Tracked via
  `sync_map.last_pulled_acc_comment_id` so the same comment doesn't get
  re-pushed every cycle.

**Both directions only sync the single latest comment**, not full
history or an ongoing thread — matches what was asked for, not a
limitation to work around later unless you want more.

**Author attribution**: since the account actually posting the synced
comment is always the syncing/reporter account (not the real author), a
`- synced from ACC by <name>` / `- synced from Revizto by <name>` suffix
is appended so it's clear who really wrote it — especially useful when
that person has no account at all on the other platform. Resolved from:
Revizto comments' own `author.firstname`/`.lastname` object (confirmed
from real data), falling back to a `reporter` (email) → license-member
lookup if `author` is ever missing; ACC comments' `createdBy` (an
Autodesk user ID, confirmed the same field/format as attachments below),
resolved to a name via the project members list's `.name` field
(confirmed from real data, e.g. `"Edgar Perez"`). If a name can't be
resolved on either side, the suffix is just omitted rather than showing
a raw ID/email.

**ACC → Revizto: the real author's own profile now shows too, not just
text.** Previously every ACC-authored comment showed up in Revizto under
the app-connected project owner's profile, with the real author only
named in that text suffix — even when they were also a genuine Revizto
team member. Fixed via `_resolveReviztoReporterEmail`: if the ACC
commenter's email matches a real member of the Revizto license, that
email is passed as the comment's `reporter` field instead of the project
owner's; falls back to the owner (text-only attribution, as before) when
there's no match. **Confirmed by real, live testing that `reporter` is
what actually drives the displayed profile** — despite the comment's
separate `author` object still always coming back as the app-connected
account regardless of `reporter` (server-assigned to whichever token
authenticated the POST, same limitation as ACC's own "Created By"; posted
a real test comment and confirmed in Revizto's UI that the profile shown
was the resolved real member, not the connected account). Same
real-member resolution now also applies to the "Attachment added via ACC
sync" notification comment and the attachment's own file comment
(`pollAccAttachmentsForProject`).

**Revizto → ACC: the real author's own ACC connection is used too, when
they have one.** Unlike the direction above, ACC's comment-create endpoint
accepts only `{ body }` — no author/reporter field of any kind — so
there's no equivalent "just pass their email" trick; the comment is
always posted as whichever ACC account actually authenticates the POST.
The fix is one level up: `_findAccUserIdForEmail` checks whether the real
Revizto author has **personally connected their own ACC account** to this
app (a `users` row with their email joined to a real `acc_tokens` row —
this app already supports every team member doing that independently,
not just the project owner) — if so, the comment (or file attachment, via
`_pushLatestFileAttachmentToAcc`, which also now posts an "Attachment
added via Revizto sync by \<name\>" note, matching the ACC→Revizto
direction's parity) is posted using **their own token**, so ACC's actual
activity log shows them, not just a text note. `_withAccUserFallback`
falls back to whichever connection the sync was already running as if
their personal connection fails for any reason (not connected, or their
connection has gone idle-dead — see below).

**Why this needed a second piece: Autodesk revokes an idle refresh
token.** Confirmed by real testing: a real, previously-working ACC
connection came back `grant revoked due to idle timeout` after roughly 3
weeks of not being used — which would otherwise make per-user attribution
silently stop working for anyone who doesn't happen to touch
ACC-connected features often. Fixed with `pollService.
keepAccConnectionsAlive`, a new daily cron job (`ACC_KEEPALIVE_CRON`,
default `0 3 * * *`) that calls `getValidAccToken` for every connected
user regardless of whether they've used anything — a refresh counts as
activity to Autodesk, resetting the idle clock, so this alone keeps every
connection alive indefinitely with zero engagement required from that
person. Cheap to run often: `getValidAccToken` only actually calls
Autodesk when the cached access token (short-lived, ~1hr) has already
expired, so most daily runs for an active connection are a local no-op.
**This can't revive an already-dead connection** — confirmed by testing,
two real connections that had already gone idle before this job existed
needed a fresh reconnect (My Connections page), not just a refresh
attempt, to work again.

GET comments' response shape is now confirmed from real data:
`{id, issueId, body, createdBy, createdAt, updatedAt, deletedAt, ...}` —
matches what was previously just extrapolated from the POST shape.

### Field-change attribution (ACC → Revizto), phase 1

Extends the same real-member attribution above from comments/attachments
to **field changes** — status, assignee, watchers, priority, due date,
title — pushed by `handleAccWebhook`. Every diff-comment those generate
in Revizto previously used a fixed `reporterEmail` (the project owner),
regardless of who actually made the change in ACC. `_resolveEffective
ReporterEmail` resolves `accIssue.updatedBy` (an Autodesk user ID — the
same field/mechanism already confirmed used for comments'/attachments'
`createdBy`, just reflecting the issue's last editor instead of a
comment's author) to a real ACC member, then checks whether they're also
a real Revizto license member (`_resolveReviztoReporterEmail`, already
proven live for comments) — if so, every diff-comment this webhook
handler posts is attributed to them; falls back to the project owner
(unchanged behavior) otherwise. Resolved once per webhook call and reused
across all six field types, rather than re-resolved per field.

**Revizto → ACC field changes were initially NOT covered by this fix**
(a deliberate phase-1 scope decision, not an oversight) — unlike a single
new comment or attachment, a full issue resync re-sends the entire
computed payload every 2-minute cycle regardless of what specifically
changed, so there was no clean "this one field change = this one person"
signal the way `createdBy`/`updatedBy` provide on the ACC side. See
"Field-change attribution (Revizto → ACC), phase 2" below for how this
gap was closed.

**Pre-existing bug fixed in passing, unrelated to the above**: this
function's final `return` referenced an undefined `newStatus` variable,
throwing a `ReferenceError` on literally every successful webhook
delivery since this function was written. Harmless in practice — the
route handler that calls this only logs the error, and all the real sync
work (status/assignee/watchers/priority/due-date/title) had already
completed by that point — but it polluted logs with a crash that looked
far worse than what was actually happening. Now returns
`resolution.targetStatusName` (undefined for an ambiguous status, same as
before — just no longer a crash).

**Needs a one-time backfill for existing projects**: this required adding
the Revizto project's **numeric ID** (separate from the UUID used
everywhere else — `GET /issue/{uuid}/comments/date` oddly wants the
numeric one). New projects capture this automatically from the dropdown;
existing ones show a small "Missing numeric Revizto project ID" prompt on
the Setup page — find the number in Revizto (visible via `Get license
projects`, or ask your Revizto contact) and save it there once.

**Migration needed**: `projects.revizto_project_id`,
`sync_map.last_pushed_comment_uuid`, and
`sync_map.last_pulled_acc_comment_id` (idempotent `ALTER TABLE`). Run
`npm run migrate`.

### Field-change attribution (Revizto → ACC), phase 2

Closes the gap phase 1 deliberately left open. The missing signal turned
out to already exist: editing a field (status, assignee, watchers,
priority, due date, title) through Revizto's own UI posts the exact same
`type: 'diff'` comment shape this app itself writes when relaying an
ACC-driven change back into Revizto (`reviztoService._postDiffComment`) —
confirmed by the person who actually uses Revizto day to day, not
independently tested against a live API response, so treat the mechanism
as strongly likely rather than fully proven until it's watched working
end-to-end. `GET /issue/{uuid}/comments/date` returns every comment type
mixed together (confirmed from real docs — "text/file/diff/markup"), and
`pushIssueToAcc` already fetches that full list once per push cycle for
the comment/markup/file-attachment sync — so reading diff comments for
attribution costs nothing extra.

**The other half of the problem**: even with that signal, a full
issue resync re-sends every field every 2-minute cycle regardless of
whether it changed, so "a diff comment exists somewhere in the history"
isn't enough on its own — it has to be a diff comment for a field that
**actually changed since the last push**, or every cycle would
misattribute to whoever's diff comment happens to be newest, changed or
not. `sync_map.last_synced_revizto_fields` snapshots the six
diff-comment-tracked fields (in the same shape/keys `_postDiffComment`
itself writes with) as of the last successful push;
`syncService._changedReviztoFieldKeys` diffs the current values against
it every cycle to find out what, if anything, genuinely changed.
Only then does `_findReviztoFieldEditorEmail` scan the shared comment
list (newest first) for the latest `diff` comment naming one of those
changed fields, and use its author. If several fields changed via
separate edits within the same 2-minute window, the whole push is
attributed to whoever made the **latest** one — same "latest wins"
policy already used for comments/markup/file attachments elsewhere in
this file, not a new rule invented for this feature.

**Attribution mechanism itself reuses phase 1's comment/attachment
plumbing exactly**: the resolved editor's email is checked against
`_findAccUserIdForEmail` (do they have their own ACC connection?), and if
so the actual `accService.createIssue`/`updateIssue` call runs under
**their** token via `_withAccUserFallback`, so ACC's own "Modified By"
shows them — not a text note claiming it, an actual per-request identity
switch, same as the real per-user ACC posting phase 1 added for comments
and file attachments. Falls back to the project's default connection
(unchanged prior behavior) whenever nothing changed, no comments could be
fetched, no matching diff comment is found (e.g. the change predates this
feature), or the resolved editor has no personal ACC connection.

**Cold start**: `last_synced_revizto_fields` is `NULL` for every issue
until its first push after this feature ships — that first push has
nothing to diff against, so it just establishes the baseline
(`_changedReviztoFieldKeys` returns no changes for a null previous
snapshot) rather than guessing off no data. Attribution starts working
from the following cycle onward.

**Migration needed**: `sync_map.last_synced_revizto_fields` (JSONB,
idempotent `ALTER TABLE`). Run `npm run migrate`.

## Field mapping — what's automatic vs. what's admin-configurable

Two different mechanisms, don't confuse them:

- **Automatic** — always applied on every push, no setup required. Either
  there's nothing to configure (direct copy) or the mapping is resolved
  live against real data (e.g. matching a name against a live list) rather
  than a stored table.
- **Admin-configurable (manual)** — an admin picks the mapping on `/setup`
  per project; it's stored in the database and takes priority over a
  hardcoded fallback used when nothing's configured yet.

| Revizto field | ACC field | Direction | How it's mapped |
|---|---|---|---|
| `title` | `title` | Both | Automatic — Revizto → ACC is a direct copy; ACC → Revizto uses the same diff-comment mechanism as priority/due date below, posting "Title changed via ACC sync" |
| *(none — Revizto has no description field)* | `description` | Revizto → ACC | Automatic — fixed marker `"Synced from Revizto"`, so issues are filterable in ACC by description |
| `customStatusName` | `status` (+ an optional "Revizto Status" ACC custom field for precision) | Both, admin-configurable both ways, scoped per Revizto workflow | See "Status mapping — per workflow, both directions" below |
| `stampAbbr` (shown as "Category > Stamp Title") | `issueSubtypeId` (issue type) | Revizto → ACC | **Admin-configurable** (Setup page) — falls back through: project's default subtype → title-keyword guess → auto-detected "General" subtype → first available, so a push can never fail from a missing subtype. Unmapped flags a sync error |
| `clashAndLocationFields.level` | `locationId` | Revizto → ACC | Automatic — matched by name against the ACC project's own Location Breakdown Structure (live lookup, nothing stored); no match just leaves it unset |
| `clashAndLocationFields.zone` | `locationDetails` | Revizto → ACC | Automatic — free text, always written when a zone is set (kept separate from level so it isn't used as a location fallback) |
| `clashAndLocationFields.grid` / `.room`, `tags`, issue's own numeric ID, `priority` | ACC custom fields ("Grid Intersection", "Room", "Tags", "Revizto ID", "Issue Priority") | Priority is bidirectional; the rest are Revizto → ACC | Automatic — matched by title against the project's own custom fields (ACC has no native fields for these), see "Custom field mapping" below |
| `created` | ACC custom field ("Date Created") — **not** ACC's native "Created On" | Revizto → ACC only | Automatic, same mechanism as the row above. See "Why a custom field, not ACC's native Created On" below |
| `author` (falls back to `reporter`) | ACC custom field ("Reporter") — **not** ACC's native "Created By" | Revizto → ACC only | Automatic, same mechanism/reasoning as `created` → "Date Created" just above — see the same section below |
| `openLinks.redirect` | ACC custom field ("Revizto URL") | Revizto → ACC only | Automatic — a clickable https:// link that opens the issue in the desktop Revizto app (falls back to the web tracker if not installed). See "Revizto URL" below |
| `deadline` | `dueDate` | Both | Automatic — direct copy; ACC → Revizto also posts a one-time "Deadline changed via ACC sync" comment, see below |
| `assignee` (email) | `assignedTo` | Both | Automatic — resolved via ACC's project members list, with an optional manual per-project override (`user_map` table, not exposed in the UI yet) |
| `watchers` (emails) | `watchers` | Both | Same resolution as assignee, just an array |
| latest text comment | comment | Both | Automatic — only the single latest comment, not full history |
| markup preview image (with drawings) | attachment | Revizto → ACC | Automatic — only the latest markup version, uploaded once per version |
| file attachment (photo, PDF, etc. — a "file" comment) | attachment | Revizto → ACC | Automatic — latest only, same policy as markup/comments. See "File attachment sync" below for the byte-identical-vs-recompressed caveat and ping-pong guards |
| *(reverse: ACC attachments)* | photo/PDF attachment | ACC → Revizto | Automatic, polling-based — see "Attachment sync" below |

### Status mapping — per workflow, both directions

The 4 canonical Revizto status names — `Open`, `In progress`, `Solved`,
`Closed` — always auto-map to a fixed ACC status, in **any** workflow, no
admin config needed (`fieldMapping.REVIZTO_AUTO_MAPPED_STATUSES`/
`ACC_AUTO_MAPPED_STATUSES`, inverses of each other so the two directions
can't drift out of sync). Shown greyed out on the Setup page as a
read-only "already handled" row, labeled "Standard Workflow".

*(An earlier version of this mapping was category-based — Revizto's
`statuses[].category`: "To do"/"Tracking"/"Completed", confirmed from real
docs — deliberately reverted back to name-based auto-routing on explicit
request; category isn't read anywhere in the current code.)*

Every other **custom** status needs an explicit admin mapping — and since
a project can have multiple workflows, and two workflows can each define
a same-named custom status that should map differently, this mapping is
scoped **per workflow**, not just by name (`status_map.workflow_uuid`,
`''` for rows saved before this scoping existed, used as a fallback
bucket so old mappings keep applying rather than silently disappearing).
The Setup page groups custom statuses by the workflow they belong to,
labeled with Revizto's own confirmed `workflow.name` field (falls back to
a numbered "Custom workflow N" if that's ever missing). A workflow
currently governing at least one real issue has all of its statuses
listed as required — unmapped ones highlighted red, defaulting to ACC
`Draft` as a safeguard and flagging a sync error/warning until mapped; a
workflow not yet in use lists its statuses as optional, for
pre-configuring ahead of time without a false warning.

**Reverse direction (ACC → Revizto)**, `syncService.
_resolveReviztoStatusFromAcc`: the same 4 canonical ACC statuses always
auto-map back, no admin config. Every other ACC status is resolved
against this workflow's own `status_map` rows, reversed — the primary
status wins outright when exactly one status in the workflow maps to it;
only when that's genuinely ambiguous (multiple matches) does it defer to
the secondary "Revizto Status" field to disambiguate — see the full
resolution order under "Secondary ACC 'Revizto Status' field" below.
Truly unresolvable either way: ACC's primary status is defaulted back to
`Draft` and a warning is flagged (`recordSyncError`, same mechanism as
every other mapping warning) — Revizto's own status is left untouched,
since the app doesn't know which one was meant. Zero matches with no
secondary field set falls back to the pre-existing hardcoded guess
(`mapStatusFromAcc`), unchanged from before this feature.

**Migration needed**: `status_map.workflow_uuid`,
`status_map.acc_custom_status_option_id`. Run `npm run migrate`.

### Secondary ACC "Revizto Status" field — precise reverse mapping

ACC's primary status is a fixed 9-value enum, coarser than a custom
workflow's real status set — several custom statuses in one workflow can
legitimately share the same primary ACC status (e.g. "Revise" and "Field
Fix" both → `open`). Fine for the forward push, but it makes the reverse
direction ambiguous on its own: an ACC user changing the primary status
to `open` doesn't say which of several possible Revizto statuses was
meant — see step 2 above.

The fix: an admin creates a **list-type custom field in ACC** to hold the
precise target. Either one shared field titled exactly "Revizto Status",
or — recommended once a project has several workflows, so each dropdown
only shows that workflow's own statuses instead of one long combined list
— one field per workflow, titled "Revizto Status - &lt;workflow name&gt;"
(e.g. "Revizto Status - Pre Pour Checklist"), matched by that exact name
suffix against the workflow's own name — case-insensitive, but **not**
fuzzy, so a naming mismatch (typo, singular/plural, extra word) is the
first thing to check if a workflow's dropdown unexpectedly shows "Not
available". `fieldMapping.isReviztoStatusFieldTitle`/
`pickReviztoStatusField` do the discovery and per-workflow matching,
shared by both directions (`syncService.makeReviztoStatusFieldResolver`
for the push, `_resolveReviztoStatusFromAcc` for the pull).

A custom status whose name **exactly matches** one of that field's
options auto-maps with nothing to configure — greyed out with an "auto"
badge on the Setup page, same idea as the 4 canonical statuses. Otherwise
it's admin-configurable, same red-highlight-when-unmapped treatment as
the primary status column (though unlike the primary column, an unmapped
secondary field is a display-only nudge, not counted in the "N unmapped
fields" warning — the primary mapping alone already has a safe fallback).

On a Revizto → ACC push, this field is set alongside the primary status
whenever a mapping (explicit or auto-matched) resolves it.

**On the ACC → Revizto pull, whichever field actually just changed wins —
the other one gets corrected to match.** ACC's webhook payload carries no
field-level diff (just the issue's current state), so "which field just
changed" can't be inferred from a single snapshot alone: an early version
of this checked the secondary field unconditionally first, which broke
unambiguous primary-status changes (a stale secondary selection overrode
them); the next version made an unambiguous primary status always win,
which broke genuine secondary-field changes whenever the *current* primary
status happened to already be unambiguous (very likely right after a
previous primary-status change). The fix: `sync_map.
last_acc_secondary_option_id` tracks the secondary field's value as of the
last webhook processed for that issue, so `_resolveReviztoStatusFromAcc`
can tell whether the secondary field's current value is actually new.
Actual order:
1. **Secondary field just changed** (differs from last time) → it wins
   outright: an explicit `status_map` row match, else an exact name match
   against the workflow's own status names (same zero-config idea as the
   4 canonical statuses). Corrects ACC's primary status field to match.
2. **Otherwise, primary status unambiguous** (exactly one status in this
   workflow maps to it, canonical auto-map included when the canonical
   name is a real status in that workflow) → that status wins. Corrects
   the secondary field to match, if it doesn't already.
3. **Otherwise** (primary ambiguous or unmapped, secondary didn't just
   change) — the secondary field's *current* value, even though it didn't
   just change, is still used as a disambiguator if set (same resolution
   as step 1, no correction needed either way since neither just moved).
   Set but unresolvable, or primary ambiguous with nothing to
   disambiguate it: ambiguous — caller defaults ACC's primary status to
   `Draft` rather than guessing, and flags a warning. Primary unmapped
   with no secondary set: falls back to the pre-existing hardcoded guess
   (`mapStatusFromAcc`), unchanged — never corrects either ACC field,
   since "correcting" a guess could wrongly overwrite a legitimate ACC
   status (e.g. `pending`, `draft`) with no clean Revizto equivalent.

Either correction direction is guarded against a redundant self-triggered
webhook loop by only writing when the field doesn't already match.

**Migration needed**: `sync_map.last_acc_secondary_option_id`. Run
`npm run migrate`.

### Issue type mapping — guaranteed to resolve to something

**Revizto stamp** (dropdown, "Category > Stamp Title", value stored is
the abbreviation — matches `stampAbbr`) → **ACC issue type** (dropdown,
real subtypes from ACC). Every stamp currently in use is listed; unmapped
ones are highlighted red.

Unmapped falls back through, in order: the project's configured **default
subtype** (a real per-project setting now — see below) → a title-keyword
guess → an auto-detected subtype literally named **"General"** → whatever
subtype happens to be first. This chain always resolves to *something* —
confirmed by real testing that ACC rejects a create/update with a 400 if
`issueSubtypeId` is missing entirely, which happened once before this
fallback existed. Unmapped also flags a sync error/warning.

**Default ACC issue type** (`projects.acc_default_subtype_id`) used to be
settable only via a raw ID text field on project creation, with no way to
view or change it afterward — now has a proper dropdown per project on
the Setup page (`PATCH /api/projects/:id/default-subtype`).

Both mapping tables (`status_map`, `type_map`) take priority over their
fallback chain, so turning this feature on doesn't risk breaking projects
that haven't touched it yet.

**Migration needed**: `status_map`, `type_map` tables (already existed);
no new migration for the category logic itself — it reads Revizto's live
workflow settings on every push, nothing new stored.

### Level & zone — the automatic ones

**Level → ACC's Location field (`locationId`)**: resolved by matching the
Revizto issue's level name against the ACC project's own configured
Location Breakdown Structure (fetched live via `GET
construction/locations/v2/projects/{id}/trees/default/nodes`, matched
case-insensitively by node name) — no admin setup, and nothing stored
locally. If the ACC project has no Locations tree configured, or no node's
name matches, `locationId` is simply left unset for that push rather than
failing it.

**Zone → ACC's Location Details field (`locationDetails`)**: always written
as plain text when the Revizto issue has a zone set. Deliberately kept
separate from the level/`locationId` mapping above — `locationDetails`
isn't used as a fallback when level has no matching location node, so it
stays reserved for zone specifically.

Both pull from Revizto's `clashAndLocationFields` object — **only present
on the response if explicitly requested**: confirmed from real testing
that `additionalFields: ['appendClashAndLocationFields']` must be passed
on `issue-filter/filter`, since `sendFullIssueData: true` alone does not
include it (a real bug hit and fixed while building this — see
`reviztoService.getIssues`/`getIssue`).

No migration needed — this reads live from both systems on every push,
nothing new is stored in the database.

### Custom field mapping — Grid, Room, Tags, Revizto ID, Date Created, Reporter, Revizto URL, Issue Priority

ACC has no native fields for grid intersection, room, tags, or "the
Revizto issue's own ID" — these map to **admin-created ACC custom
fields** instead, matched by title (a fixed managed list, not every
custom field in the project) and only written if ACC's own
`issue-attribute-mappings` says that field actually applies to the
issue's subtype (checked at the subtype, issue-type, *or* project-wide
level — confirmed by real testing that a field correctly enabled in ACC
still showed as "unmapped" until the issue-type-level case was added).
The "Revizto Status" field(s) covered above use this exact same
subtype-applicability check, but their own dedicated resolver
(`makeReviztoStatusFieldResolver`) rather than this fixed managed list —
a project can have several of them (one per workflow), unlike every field
here which is always exactly one fixed title.

**Issue Priority** is the one bidirectional field here: Revizto → ACC
resolves the raw priority string to the matching **dropdown option ID**
(confirmed ACC list-type custom fields require the ID, not the label).
ACC → Revizto reads the field back off the webhook payload and resolves
the option ID back to a label — confirmed by real testing that ACC's GET
response returns the raw option ID here too, not a readable label as the
docs implied — then lowercases it to match Revizto's own value format.

No migration needed for any of this — nothing new stored, all resolved
live against ACC's real custom field definitions on every push.

#### Why "Date Created" / "Reporter" are custom fields, not ACC's native Created On / Created By

Both of ACC's built-in columns are server-assigned at the moment the issue
record is POSTed to ACC — confirmed against Autodesk's own create-issue
request schema, neither `createdAt` nor `createdBy` is an accepted field
in the request body, only in responses. `createdBy` specifically is set to
whichever ACC account **this app's own connection** used to make the POST
(the project's owner user) — confirmed by testing, a real synced issue's
`createdBy` resolved to that owner's Autodesk ID, not the Revizto issue's
actual author. So both native columns always read as "sync
metadata" (when this app pushed it, which app-connected user pushed it),
never the issue's real origin — exactly backwards from what they should
show, since the creating author/platform is what actually determines an
issue's real origin, not this app relaying it. There's no way to override
either via the API.

The fix, same shape for both: `reviztoIssue.created` → managed custom
field **"Date Created"**; `reviztoIssue.author` (richer, falls back to
`reviztoIssue.reporter` if `author` isn't populated) → managed custom
field **"Reporter"** — same mechanism as Grid/Room/Tags/Revizto ID above,
Revizto → ACC only in both cases (an ACC → Revizto direction would make no
sense: neither of Revizto's own values can change after the issue
exists). Both written on every push, same as Revizto ID, since re-sending
an unchanging value is a harmless no-op.

**Needs an ACC admin to fully take effect.** Both fields already existed
in this project (provisioned ahead of time, unused) but were originally
mapped to only a single issue subtype each — confirmed via
`issue-attribute-mappings` during testing, any *other* subtype's issues
silently skipped them with a `[sync] ... isn't mapped to this issue's
subtype` warning. An issue-type-level mapping for the "Revizto" issue type
has since been added for both (confirmed working end-to-end against a
real linked issue: "Date Created" now shows the real Revizto creation
date, "Reporter" shows the real author name, not sync metadata) — but
that's only 1 of the 11 issue types in this project, and real synced
issues already span at least 4 of them (**Revizto, Design, General,
Coordination**, confirmed from live linked issues). Compare against
"Revizto ID", which is further along but *also* incomplete — mapped to 4
of 11 issue types (Design, Coordination, Observation, Revizto), missing
**General** among others, so a currently-linked issue under "General"
(Revizto #28) has zero custom attributes set at all despite Revizto ID
being otherwise reliable. To close the gap for real: ACC → Project Admin
→ Issues → Custom attributes/fields → for "Date Created", "Reporter",
"Revizto URL" (below), and ideally "Revizto ID"/"Tags"/"Grid Intersection"
too → enable each for every issue type actually in use (or project-wide,
simplest) rather than whichever handful are mapped today.

#### Revizto URL

`reviztoIssue.openLinks.redirect` → managed custom field **"Revizto
URL"** — a direct link back to the issue that opens the **desktop
Revizto application** (explicit request). Revizto → ACC only, written on
every push, same treatment as Date Created/Reporter (the link doesn't
change either). `openLinks` is present on every real issue response with
no extra request params needed — unlike `clashAndLocationFields`, it
isn't gated behind `additionalFields`.

**Went through 3 iterations before landing here, each confirmed by
real testing, not assumed:**
1. `.web` (Revizto Workspace's web app, a real `https://` URL) — worked
   and rendered clickable in ACC, but opened the web tracker, not the
   desktop app (the actual ask).
2. `.desktop` — the *real* `revizto5://` custom-protocol URI, and does
   correctly launch the desktop app when it works — but confirmed by
   testing that **ACC does not render a non-`http(s)` custom scheme as a
   clickable link at all**. Correct destination, wrong transport.
3. `.redirect` — a real `https://` URL, so clickable in ACC same as
   `.web`; confirmed by testing (loaded it directly) that it embeds and
   auto-launches that same `revizto5://` URI, falling back to "Open in
   the web issue tracker" if Revizto isn't installed. The best of both —
   despite Revizto's own docs describing `.redirect` as being for the
   mobile Site app specifically, not desktop, real behavior wins out over
   the docs here.

**Same mapping-scope caveat as above** — this field also existed
pre-provisioned but scoped to a single subtype; **confirmed by testing
that ACC's API hard-rejects a customAttributes write to an unmapped
field** (`400: "custom attribute definition is deleted or unmapped"`),
which is exactly why `customAttributeResolver`'s subtype-applicability
check exists rather than being a defensive nicety.

## Title, priority & due date (bidirectional)

All three work the same way structurally: Revizto → ACC on every push;
ACC → Revizto via the webhook, using the same diff-comment mechanism
already proven for status/assignee/watchers.

**Title**: plain direct copy both ways — no format conversion needed,
unlike due date below. Posts a one-time "Title changed via ACC sync"
comment when it actually changes. Verified end-to-end against a real
issue (`updateIssueTitle`, changed and reverted during testing).

**Due date**: ACC's `dueDate` is date-only; Revizto's `deadline` is a
full datetime. Writing back is anchored at **noon**, not midnight —
confirmed by real testing that midnight showed up a day *early* in
Revizto (a timezone-boundary shift crossing into the previous day at that
exact boundary). Also posts a one-time "Deadline changed via ACC sync"
comment when the date actually changes, tagged so it doesn't get echoed
back into ACC by the existing Revizto→ACC comment sync.

## Attachment sync (ACC → Revizto)

**Polling-based**, same reasoning as ACC comments: attachment additions
aren't confirmed to fire the `issue.updated` webhook event, so this
actively checks each linked issue every 2 minutes rather than reacting to
one. Only the single latest *new* attachment per cycle.

Listing attachments needed a dedicated endpoint (`GET
construction/issues/v1/projects/{id}/attachments/{issueId}/items`) —
confirmed by testing that the base issue GET does **not** include
attachments inline (always empty), same as comments. One real bug found:
the response wraps the array under an `attachments` key specifically, not
`results`/`data` like every other list endpoint in this file.

Every attachment (photos and PDFs alike) is pushed to Revizto as a plain
**file attachment comment**. A markup-type upload was tried first and
confirmed to correctly create a visible thumbnail in Revizto's comment
feed, but did **not** become the large image shown in Revizto's markup
editor — that likely needs real viewpoint/pin data only created by
drawing directly in Revizto's client, not reachable via this API. A
one-time "Attachment added via ACC sync" comment follows — tagged with
`by <name>` when the uploader's `createdBy` resolves to a real name (same
mechanism as comment attribution above).

Two ping-pong guards, now that attachment traffic flows both ways — skips
re-importing an attachment this app already pushed the *other* direction
(Revizto→ACC, see "File attachment sync" above for the full picture):
matches the `"Revizto Issue "` naming `_pushMarkupImageToAcc` uses for
markup images, or the exact ACC `attachmentId` recorded in `sync_map.
last_pushed_file_attachment_acc_id` for real file pushes (which use the
file's actual name, not a recognizable pattern, so name-matching alone
wouldn't catch those). The resulting Revizto comment's own uuid is also
recorded (`sync_map.last_pulled_acc_attachment_comment_uuid`) so the
Revizto→ACC direction can return the favor and recognize *this* comment.

**Migration needed**: `sync_map.last_pulled_acc_attachment_id`,
`sync_map.last_pulled_acc_attachment_comment_uuid` (idempotent
`ALTER TABLE`). Run `npm run migrate`.

## Syncing issues (updated model)

**Linking is manual; staying in sync is automatic.**

1. Click **"Link new issues"** on a project row, check specific Revizto
   issues, click **"Link & push selected"**. This creates the ACC issue and
   records the link (in `sync_map`) — this is the only manual step.
2. From then on, that issue **auto-resyncs Revizto→ACC every 2 minutes**
   (`POLL_ENABLED=true` by default, `POLL_CRON` controls the schedule) —
   no further clicks needed. This only touches issues already linked; it
   never auto-links new ones **unless auto-sync-by-filter is turned on for
   the project** — see below.
3. **ACC→Revizto** happens via webhook — see "Webhooks" below. This is the
   piece that still needs a real deployment to actually test.
4. Click **"Show linked issues"** any time to see a two-column view:
   Revizto's current title/status next to ACC's, for every linked issue.

The webhook side (ACC→Revizto) now updates status, assignee/watchers,
priority, due date, title, the latest comment, and attachments — every
field in the mapping table above except description (Revizto has none)
syncs both ways, all via the same status-via-diff-comment mechanism,
extended field by field.

### Broken links: self-heal and manual unlink

If the ACC issue behind a linked Revizto issue is deleted directly in ACC
(outside this app), ACC's API returns **403 Forbidden** for it — not 404
as would normally be expected, confirmed by real testing (ACC's
Construction Issues API apparently reports a nonexistent issue ID as an
access error, not a not-found one — see `syncService.
_isAccIssueGoneError`). Both places that read/write that ACC issue treat
this the same way: `pushIssueToAcc` (the 2-minute auto-resync and manual
pushes) and `getIssuesBoard` (the Issues page's own read) both clear the
stale `sync_map` row rather than erroring on it forever. Deliberately does
**not** silently recreate a replacement issue in ACC on its own — an
admin who intentionally deleted issues in ACC wants them to show up as
unlinked and ready to review/relink deliberately, not have this app
recreate them automatically on the next poll cycle. The issue just
reverts to "unlinked" and becomes available to relink normally (manually,
or via auto-sync-by-filter).

#### Real incident: a transient blip once unlinked every issue at once

A 403/404 (or, in `getIssuesBoard`'s bulk-fetch path, an issue simply
being **absent** from ACC's own issue list — no error involved at all)
used to trigger the self-heal above **immediately, on the very first
sighting**. A real incident showed why that's dangerous: some transient
failure (root cause never pinned down — directly tested that a genuinely
bad/expired ACC token returns **401**, not 403, so it wasn't simply an
expired connection) made ACC issues look "gone" for an entire poll cycle,
and every currently-linked issue got unlinked at once. Confirmed
afterward, individually, that **every one of those ACC issues still
existed and was never deleted** (`deleted: false` on each) — a false
positive, not a real cleanup.

**Fix: a grace period, confirmed across multiple separate checks.**
`sync_map.acc_issue_missing_since` is set the first time an issue looks
gone (`_handlePossibleAccIssueGone`) — the link is **not** touched yet, it
just shows a "confirming before unlinking" error on the Issues page and
retries normally next cycle. Only once that flag has stood, unresolved,
for `syncService.ACC_ISSUE_GONE_GRACE_MS` (10 minutes — several poll
cycles at the default 2-minute schedule) does it actually unlink. A normal
successful fetch at any point clears the flag (`_clearAccIssueMissingFlag`)
— a one-off blip that resolves itself on its own next cycle never
progresses to an unlink at all. Verified end-to-end by simulating both
outcomes: an immediate check stays linked with the confirming-error state,
and only unlinks once the flag is (simulated) 11 minutes old; pointing a
flagged issue back at a real, reachable ACC issue before that clears the
flag with no unlink.

This doesn't need "a way to keep the ACC connection from expiring" —
`authManager.getValidAccToken` already refreshes the access token
automatically on every use (see "Connecting accounts" above), and a truly
dead refresh token surfaces as 401, a completely different, already
correctly-handled failure path (`ReconnectRequiredError`, not this one at
all). The actual bug was the self-heal being too trigger-happy about a
single momentary read failure, not the connection failing to renew itself.

**Manual unlink** — an admin-gated opt-in (`projects.allow_manual_unlink`,
off by default, toggled on the Setup page's "Issue linking" section) that
lets any signed-in user manually clear a link from the Issues page, for
anything that doesn't self-heal on its own. Only removes this app's own
tracked link — never deletes the issue in either system. Posts a
best-effort notification comment on both sides when used
(`syncService.unlinkIssue`), same idea as the existing deadline-change/
markup-upload comments; a failed comment post (e.g. the ACC issue is
already gone) never blocks the unlink itself.

**Migration needed**: `projects.allow_manual_unlink`,
`sync_map.acc_issue_missing_since`. Run `npm run migrate`.

### Auto-sync by filter — opt-in exception to "linking is manual"

Setup page, off by default per project. Lets an admin auto-link+push any
**currently-unlinked** issue matching a set of filter criteria — the same
12 fields as the Issues page's own filters (status, stamp category, issue
type, stamp, assignee, assignee company, tag, priority, level, zone, room,
is-a-clash), rendered with the exact same multi-select dropdown component
(factored out into `public/js/multiselect.js`, shared by both pages).
Multiple values within one filter are OR'd together; different filters
are AND'd together — leave a filter empty to not constrain on it.

Runs on the same 2-minute poll cycle as the existing auto-resync
(`syncService.autoLinkMatchingIssues`, called from `pollService.js`
alongside `pushLinkedIssues`). **Deliberately continuous, not one-time**:
every cycle re-checks every currently-unlinked issue against the saved
criteria — this means turning the toggle on sweeps up any pre-existing
matching backlog immediately (not just issues created afterward), and an
issue edited later to newly match (e.g. priority bumped to Critical) gets
picked up on its own without needing to re-save the filter. Once a match
is found, it's linked via the exact same code path as the manual "Link &
push selected" button (`syncService.pushSelectedIssues`'s `_pushIssueList`
helper), so there's no separate/divergent linking logic to maintain.

Leaving every filter empty is treated as "nothing to auto-link," even
with the toggle on — there's deliberately no "auto-link everything"
switch here, since that would undo the "manual to link" design entirely
rather than add selective flexibility on top of it.

Stored in `projects.auto_sync_enabled` (boolean) and a new
`auto_sync_filters` table (one row per project/field/value triple).
`GET`/`POST /api/projects/:id/auto-sync-filters`; filter option *values*
reuse the existing `/issues-board` endpoint rather than a separate
options endpoint, since it's the same real data the Issues page's own
filters already draw from.

**Migration needed**: `projects.auto_sync_enabled`, new
`auto_sync_filters` table. Run `npm run migrate`.

### Pausing automatic syncing (testing)

Admin-only toggle at the top of the Setup page ("Automatic syncing" —
applies globally, not scoped to the project selected below it), added so
the app can be tested/left running without constantly calling Revizto's
and ACC's APIs. Backed by a single global (not per-project) key/value
table, `app_settings` (`services/appSettings.js`) — deliberately not a
`projects` column, since this is meant as one whole-app kill switch, not
a per-project setting.

When off, two things are skipped:
- `pollService.pollAllProjects` — the entire 2-minute cycle: the
  Revizto→ACC auto-resync, auto-sync-by-filter, and the ACC→Revizto
  comment/attachment polling all live in this one function, so gating it
  at the top covers all of them in one place.
- Incoming ACC webhook deliveries (`_handleAccWebhookRequest`) — still
  acknowledged with `200 ok` immediately (Autodesk expects a fast
  response regardless), just not acted on.

**Deliberately does NOT block manual, on-demand actions** — "Link & push
selected" and similar explicit button clicks on the Issues page still
work while paused. The toggle exists to stop the app quietly hammering
both APIs in the background, not to prevent someone from testing a
specific manual action on purpose.

The daily ACC keepalive cron (`keepAccConnectionsAlive`, see "Autodesk
revokes an idle refresh token" above) is **not** gated by this — it's one
cheap call per connected user per day, not the "all day every day"
background activity this toggle targets, and turning it off would
actively work against its own purpose (preventing idle token
revocation) during exactly the kind of extended pause this toggle is for.

**Migration needed**: new `app_settings` table. Run `npm run migrate`.

## Webhooks — registering the ACC side

Registration is now **automatic**: `routes/index.js`'s `_autoRegisterWebhook`
fires right after a project pairing is created or modified (Setup page, see
"Adding a project pairing" below) — no manual button anymore. It still
**requires `PUBLIC_BASE_URL` to be set to a real, internet-reachable HTTPS
URL**; it deliberately no-ops (not a hard failure — the pairing itself still
saves) against `localhost`, since ACC's servers can't reach your laptop.
Deploy first (see "Deployment" below) and set `PUBLIC_BASE_URL` to that real
URL before pairing a project if you want the webhook to register on save;
otherwise re-save the pairing (Modify pairing → Save, no fields need to
actually change) once deployed to trigger it retroactively.

The underlying manual route (`POST /api/projects/:id/register-webhook`) and
its diagnostic siblings (`relink-webhook`, `webhook-status`, delete, and the
webhook.site test-delivery route) still exist server-side for recovery, just
no longer surfaced in the Setup UI — it got noisy once the webhook path
proved stable. Re-add UI for one of these if a delivery mystery ever needs
debugging again.

**Hard-won discovery**: registrations against `/webhook/acc` stopped
receiving deliveries at some point despite the hook showing `active` with
a correct callback URL and scope — everything checked out except actual
delivery. A curl test confirmed the endpoint itself was externally
reachable; a control hook pointed at webhook.site worked instantly and
repeatedly with identical config otherwise. Registering against a
brand-new path (`/webhook/acc-v2`) fixed it immediately. Best working
theory: Autodesk's delivery system tracks failure history **per callback
URL**, independent of the hook resource's own ID, so recreating the hook
doesn't help once a URL has enough failed delivery attempts against it
(this URL genuinely failed repeatedly earlier — free-tier spin-down, a
stale leftover ngrok hook). Not confirmed in Autodesk's own docs (the
relevant page is JS-rendered and unreadable via fetch) — treat as a
strong theory, not certainty.

`register-webhook` now points at `/webhook/acc-v2` by default.
`/webhook/acc` is still handled by the same code (kept alive in case it
ever recovers) but nothing registers against it anymore. If delivery ever
silently stops again, registering against yet another fresh path is the
first thing to try before assuming something else broke.

## Adding a project pairing

The Setup page's "Map license & project" step is two stacked Revizto/ACC
mapping tables, same visual language as status mapping:

1. **License ↔ hub** — pick your Revizto license and your ACC hub, Save.
   This is what scopes the project dropdowns below (mirrors each other:
   `revizto_tokens.license_id` / `acc_tokens.default_hub_id`, both per-user
   "current context" selections). A pulsing green dot shows once both are
   set.
2. **Project pairings** — each row links one Revizto project to one ACC
   project by **name**, picked from real dropdowns (`GET /api/revizto/
   projects`, `GET /api/acc/hubs/:hubId/projects`) — no raw IDs typed or
   shown anywhere in this UI. `projects.name` is auto-filled from the
   selected Revizto project's own title (no separate nickname field to
   fill in); `projects.acc_project_name` is captured the same way from the
   ACC side at save time, so a locked row always has a real name to show on
   both sides without depending on the currently-selected hub's live
   project list still containing it.

**Migration needed**: `acc_tokens.default_hub_id`, `projects.acc_project_name`.
Run `npm run migrate`.

A saved pairing renders **locked** (plain text, greyed) with a "Modify
pairing" button — protects against an accidental change to a live pairing.
Modifying re-opens the same two dropdowns pre-filled with the current
selections; Save calls `PATCH /api/projects/:id` (new — previously only
narrow single-field routes like `/default-subtype` existed). The row's dot
reflects whether the sync webhook actually registered (`projects.webhook_id`
set), not just whether the row exists.

There's deliberately no "add a pairing" UI here anymore — a project only
ever has one pairing, set once. New pairings will be created by starting a
new project instead (see "Planned: multi-project workspaces" below); the
backend route (`POST /api/projects`) still exists for that, it's just not
wired to any button yet.

**ACC hub/project browsing requires ACC Custom Integration approval** (see
below) — this account has it, so the dropdowns work; without it, `GET
/api/acc/hubs`/`GET /api/acc/hubs/:hubId/projects` will fail and there's
currently no manual-ID fallback UI (the old one was removed as part of this
redesign — `accService.getHubs`/`getHubProjects` and their routes are
unaffected if manual entry ever needs to come back).

**Unverified assumption to check on first real use:** the shape of Revizto's
project-list response (`uuid`/`title` fields) is now confirmed against real
docs — no longer a guess.

## Planned: multi-project workspaces & License Administration (not built)

**Status: TODO — UI mocked up (disabled) for visualization, no backend
behind it.** Not critical right now; revisit when actually needed.

The idea: each project gets its own fully separate setup instead of one
shared Setup page listing pairings.

- **"+ New Project" button**, top-right of the Setup page header
  (`#new-project-btn` in `setup.html`, currently `disabled`) — starts a new
  project, lets you rename it, and drops you into its own setup.
- **Project switcher** — the existing "Project:" dropdown
  (`#active-project-select`) already at the top of the Setup page is the
  intended home for this; today it just scopes Field mapping/Auto sync/
  Issue linking within one shared DB. Under this plan it becomes a real
  switch between fully separate projects, each with its own team members,
  setup/mappings, and issue list.
- **Separate DB per project** — so API-call/usage volume can be tracked and
  attributed per project instead of blended into one shared account. The UI
  layer stays shared; only the data backing each project's instance splits
  out.
- **License Administration** — new left-nav tab (`nav.js`, currently
  `disabled` like Analytics) for viewing/managing how many project slots the
  license allows and how many are in use, gating "+ New Project" once full.

None of the above is implemented server-side. The visible pieces are
intentionally inert mockups so the shape is visible without implying it
works: `#new-project-btn` (disabled), the "Project:" dropdown (still doing
its old job only), and the "License Administration" nav item (disabled).

## Planned: Help Center (phase 3, not built)

**Status: TODO — nav entry mocked up (disabled) for visualization, no
content or pages behind it.** Lower priority than the multi-project work
above; phase 3.

New left-nav tab (`nav.js`, currently `disabled` like Analytics and License
Administration), open to all users (not admin-gated). Planned topics:

- Best practices
- FAQ
- Video tutorials
- Contact support

No page, routing, or content exists yet — just the greyed sidebar entry so
the shape is visible.

## Getting ACC API access approved

Send your ACC Account Admin:
1. Your APS Client ID (from your APS app settings)
2. Ask them to: ACC → **Account Admin** → **Custom Integrations** → **Add Custom Integration** → paste the Client ID → name it (e.g. "Revizto Sync") → Add

This is a one-time, per-account step. It only affects the hub/project
*discovery* endpoints (now required for the Setup page's project-pairing
dropdowns, see above) — it has no bearing on direct access to a project
you're already a member of.

Check "use my connection for automated/background syncs" if you want this
project to also sync via a scheduled job (`POLL_ENABLED=true`) — background
jobs have no logged-in user, so they act using whichever user is marked
as the project's owner.

## Known limitations / open questions (be aware before relying on this)

- **Revizto token response shape is assumed, not confirmed.** The exchange/refresh
  code in `reviztoAuth.js` assumes a standard `access_token`/`refresh_token`/`expires_in`
  JSON response, matching the old app's working code — but we haven't seen a
  raw response from Revizto's docs to confirm field names. Check the first
  real exchange response and adjust `_parseTokenResponse` if needed.
- **Revizto refresh token expiry (monthly, flat vs. inactivity-based) is unconfirmed.**
  The docs say "valid for 1 month" with no mention of resetting on use. Confirm
  with Revizto support/your API contact.
- **Title is now bidirectional too** (`updateIssueTitle`, same diff-comment
  mechanism as status/assignee/watchers/priority/due date) — so every field
  in the mapping table above except description (Revizto has none) now
  syncs both ways. Verified end-to-end against a real issue (changed and
  reverted). Same UNCONFIRMED-against-docs caveat as
  priority/assignee/watchers/due date: extrapolated from the proven
  `customStatus` diff pattern, not from Revizto's own write docs.
- **New issues created directly in ACC are not yet auto-created in Revizto.**
  `handleAccWebhook` detects and logs this case but doesn't act on it — needs
  a decision on which side is source-of-truth for new issue creation before
  building it out.
- **Webhook signature verification is a TODO.** `/webhook/acc` currently
  trusts incoming payloads without verifying `WEBHOOK_SECRET` against
  Autodesk's actual signing scheme — confirm the current APS webhook docs
  before relying on this in production.
- **App identity (login) is intentionally minimal** — email only, no
  password/verification, no proof the person entering an email actually
  controls that inbox. Signup itself now requires a valid invite link
  (see "Invite links" above) rather than being fully open, but that only
  gates *who can create an account at all* — it doesn't verify identity
  once someone has a valid code. Fine for a small trusted team; replace
  with real auth (Clerk/Auth0/etc.) before this matters for real
  customers.

## Deployment

- **App**: Render or Railway (need a persistent Node process for polling/webhooks — not Vercel/Netlify, which are serverless)
- **Database**: Supabase or Neon
- Set `APS_CALLBACK_URL` to your real hosted URL before registering it in your APS app
- Rotate all credentials that were ever in the old `.env`/`revizto-tokens.json` before going live
