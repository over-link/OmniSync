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

**Inviting**: adding someone via the Team page grants access immediately
(their `users` row is created/updated with that role) — sending them an
email is a separate, optional step on top, via generic SMTP
(`SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` in `.env`; works with Gmail, SendGrid,
Postmark, Resend's SMTP relay, or your own mail server — not locked to one
vendor). If SMTP isn't configured, "Add" still works fully; it just tells
you the email wasn't sent rather than silently failing.

**Migration needed**: `users.role` and the `invites` log table are new
(added via idempotent `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS`, per the
migration pattern noted at the top of `schema.sql`). Run `npm run migrate`
after pulling this update. Also run `npm install` — `nodemailer` is a new
dependency.

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

**Unconfirmed**: the GET comments response's field names (`.body`, `.id`,
`.createdAt`) are extrapolated from the *POST* endpoint's confirmed shape
(`{body: comment}`) — the actual GET response schema was never directly
confirmed from docs or real data. If pulled ACC comments show up blank,
or new comments aren't detected, this mapping is the first thing to check.

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
| `title` | `title` | Revizto → ACC | Automatic — direct copy |
| *(none — Revizto has no description field)* | `description` | Revizto → ACC | Automatic — fixed marker `"Synced from Revizto"`, so issues are filterable in ACC by description |
| `customStatusName` category | `status` | Both (pull is one-way today, see below) | **Category-based**: "To do"/"Completed" auto-map, no config. "Tracking" (and any unresolved category) is **admin-configurable** (Setup page); falls back to ACC `Draft` + a flagged sync error if unmapped |
| `stampAbbr` (shown as "Category > Stamp Title") | `issueSubtypeId` (issue type) | Revizto → ACC | **Admin-configurable** (Setup page) — falls back through: project's default subtype → title-keyword guess → auto-detected "General" subtype → first available, so a push can never fail from a missing subtype. Unmapped flags a sync error |
| `clashAndLocationFields.level` | `locationId` | Revizto → ACC | Automatic — matched by name against the ACC project's own Location Breakdown Structure (live lookup, nothing stored); no match just leaves it unset |
| `clashAndLocationFields.zone` | `locationDetails` | Revizto → ACC | Automatic — free text, always written when a zone is set (kept separate from level so it isn't used as a location fallback) |
| `clashAndLocationFields.grid` / `.room`, `tags`, issue's own numeric ID, `priority` | ACC custom fields ("Grid Intersection", "Room", "Tags", "Revizto ID", "Issue Priority") | Priority is bidirectional; the rest are Revizto → ACC | Automatic — matched by title against the project's own custom fields (ACC has no native fields for these), see "Custom field mapping" below |
| `deadline` | `dueDate` | Both | Automatic — direct copy; ACC → Revizto also posts a one-time "Deadline changed via ACC sync" comment, see below |
| `assignee` (email) | `assignedTo` | Both | Automatic — resolved via ACC's project members list, with an optional manual per-project override (`user_map` table, not exposed in the UI yet) |
| `watchers` (emails) | `watchers` | Both | Same resolution as assignee, just an array |
| latest text comment | comment | Both | Automatic — only the single latest comment, not full history |
| markup preview image (with drawings) | attachment | Revizto → ACC | Automatic — only the latest markup version, uploaded once per version |
| *(reverse: ACC attachments)* | photo/PDF attachment | ACC → Revizto | Automatic, polling-based — see "Attachment sync" below |

### Status mapping — category-based, only "Tracking" needs config

Revizto statuses each belong to a **category**, confirmed from real docs
(`GET /project/{uuid}/issue-workflow/settings`, `statuses[].category`):
`"To do"`, `"Tracking"`, or `"Completed"`.

- **"To do"** → always ACC `open`. **"Completed"** → always ACC
  `completed`. No config, no exceptions — shown greyed out on the Setup
  page as a read-only "already handled" row.
- **"Tracking"** (and any status whose category can't be resolved) checks
  the admin-configured mapping (`status_map`, Setup page) **first** — if
  you've mapped it, your choice wins, every time. **Only if unmapped**
  does it fall back to ACC `Draft` (a deliberate safeguard value, distinct
  from any real status) and flag a sync error/warning until you map it.
- The Setup page lists **every** Tracking-category status currently in
  use on any issue (not just linked ones) — so you can configure a
  project fully before syncing starts, "so things don't slip through the
  cracks." Unmapped ones are highlighted red.

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

### Custom field mapping — Grid, Room, Tags, Revizto ID, Issue Priority

ACC has no native fields for grid intersection, room, tags, or "the
Revizto issue's own ID" — these map to **admin-created ACC custom
fields** instead, matched by title (a fixed managed list, not every
custom field in the project) and only written if ACC's own
`issue-attribute-mappings` says that field actually applies to the
issue's subtype (checked at the subtype, issue-type, *or* project-wide
level — confirmed by real testing that a field correctly enabled in ACC
still showed as "unmapped" until the issue-type-level case was added).

**Issue Priority** is the one bidirectional field here: Revizto → ACC
resolves the raw priority string to the matching **dropdown option ID**
(confirmed ACC list-type custom fields require the ID, not the label).
ACC → Revizto reads the field back off the webhook payload and resolves
the option ID back to a label — confirmed by real testing that ACC's GET
response returns the raw option ID here too, not a readable label as the
docs implied — then lowercases it to match Revizto's own value format.

No migration needed for any of this — nothing new stored, all resolved
live against ACC's real custom field definitions on every push.

## Priority & due date (bidirectional)

Both work the same way structurally: Revizto → ACC on every push;
ACC → Revizto via the webhook, using the same diff-comment mechanism
already proven for status/assignee/watchers.

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
one-time "Attachment added via ACC sync" comment follows, and a guard
skips re-importing attachments this app already pushed the other
direction (matched by the `"Revizto Issue "` naming `_pushMarkupImageToAcc`
already uses).

**Migration needed**: `sync_map.last_pulled_acc_attachment_id`
(idempotent `ALTER TABLE`). Run `npm run migrate`.

## Syncing issues (updated model)

**Linking is manual; staying in sync is automatic.**

1. Click **"Link new issues"** on a project row, check specific Revizto
   issues, click **"Link & push selected"**. This creates the ACC issue and
   records the link (in `sync_map`) — this is the only manual step.
2. From then on, that issue **auto-resyncs Revizto→ACC every 2 minutes**
   (`POLL_ENABLED=true` by default, `POLL_CRON` controls the schedule) —
   no further clicks needed. This only touches issues already linked;
   it never auto-links new ones.
3. **ACC→Revizto** happens via webhook — see "Webhooks" below. This is the
   piece that still needs a real deployment to actually test.
4. Click **"Show linked issues"** any time to see a two-column view:
   Revizto's current title/status next to ACC's, for every linked issue.

**Known limitation:** the webhook side (ACC→Revizto) now updates status,
assignee/watchers, priority, due date, the latest comment, and attachments
— just not **title** yet. Everything else uses the same status-via-
diff-comment mechanism, extended field by field.

## Webhooks — registering the ACC side

The receiving endpoint always existed; what was missing was telling ACC to
actually call it. Fixed via `POST /api/projects/:id/register-webhook`
(button: "Register ACC webhook" on each project row) — but this **requires
`PUBLIC_BASE_URL` to be set to a real, internet-reachable HTTPS URL**. It will
deliberately fail against `localhost`, since ACC's servers can't reach your
laptop. Deploy first (see "Deployment" below), set `PUBLIC_BASE_URL` to that
real URL, then click the button.

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

Each row in "Projects" links one Revizto project to one ACC project.

**Revizto side**: after connecting and selecting a license, the "Add a project
pairing" form fetches your real Revizto projects into a dropdown.

**ACC side**: this is **manual ID entry for now, by design** — not a
placeholder we forgot to finish. Listing ACC hubs/projects via the API
requires an ACC Account Admin to first add this app under **Account Admin →
Custom Integrations** (using your APS Client ID) — this is a platform
requirement, not something project membership alone grants, and is separate
from your own personal ACC permissions. See "Getting ACC API access approved"
below for what to send your admin. Until that's approved, type the ACC Hub ID
and Project ID directly (found in your ACC project's URL) — this always works
regardless of Custom Integration status, since direct access to a known
project ID only needs your own project membership.

The dropdown code for ACC (`accService.getHubs`/`getHubProjects`, and the
`/api/acc/hubs` routes) is already built and left in place — once your
Custom Integration is approved, re-add the `<select>` markup and its handlers
in `public/index.html`/`app.js` (removed for now to avoid dead UI) to switch
back to dropdown selection.

**Unverified assumption to check on first real use:** the shape of Revizto's
project-list response (`uuid`/`title` fields) is now confirmed against real
docs — no longer a guess.

## Getting ACC API access approved

Send your ACC Account Admin:
1. Your APS Client ID (from your APS app settings)
2. Ask them to: ACC → **Account Admin** → **Custom Integrations** → **Add Custom Integration** → paste the Client ID → name it (e.g. "Revizto Sync") → Add

This is a one-time, per-account step. It only affects the hub/project
*discovery* endpoints — it has no bearing on direct access to a project you're
already a member of, which is why manual entry works today without it.

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
- **ACC → Revizto doesn't sync title.** Status, assignee/watchers,
  priority, due date, latest comment, and attachments all now sync both
  ways — title is the one field still Revizto → ACC only.
- **New issues created directly in ACC are not yet auto-created in Revizto.**
  `handleAccWebhook` detects and logs this case but doesn't act on it — needs
  a decision on which side is source-of-truth for new issue creation before
  building it out.
- **Webhook signature verification is a TODO.** `/webhook/acc` currently
  trusts incoming payloads without verifying `WEBHOOK_SECRET` against
  Autodesk's actual signing scheme — confirm the current APS webhook docs
  before relying on this in production.
- **App identity (login) is intentionally minimal** — email only, no
  password/verification. Fine for a small trusted team, not for public signup.

## Deployment

- **App**: Render or Railway (need a persistent Node process for polling/webhooks — not Vercel/Netlify, which are serverless)
- **Database**: Supabase or Neon
- Set `APS_CALLBACK_URL` to your real hosted URL before registering it in your APS app
- Rotate all credentials that were ever in the old `.env`/`revizto-tokens.json` before going live
