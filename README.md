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

## Markup image upload (Revizto → ACC, higher risk than most)

Uploads the Revizto issue's largest preview image (`preview.large` —
confirmed real field, a rendered snapshot of the markup) as a file
attachment on the linked ACC issue. **Not** editable vector markup —
that's not feasible between two different platforms with different
coordinate systems/viewers; this is a picture, viewable in ACC, showing
exactly what was marked up in Revizto. Uploads once per issue (tracked
via `sync_map.markup_uploaded`), not on every re-sync.

There's no "pinned/hero image at the top of an issue" concept found in
ACC's API — the closest achievable approximation is being the first
attachment uploaded, not a distinct pinned-preview feature.

**Genuinely higher risk than the rest of this app**: the 4-step upload
pipeline (`accService.attachImageToIssue`) is built from Autodesk's own
official tutorial (get-started.aps.autodesk.com/tutorials/acc-issues/more)
— a real, first-party source, not a guess — but has **not been tested
end-to-end**. Worth knowing: a developer publicly hit a 409 error
attempting this using the *wrong* base path (`construction/issues/v1`
instead of the documented `issues/v1` — a completely different prefix
than every other Issues endpoint in this app uses); our implementation
uses the documented correct path, but that alone doesn't guarantee every
other step (folder lookup, storage creation body schema, signed-upload
finalize step) works exactly as expected on first try. Wrapped in
try/catch so a failure here doesn't take down the rest of an issue's
sync — check server logs for the real error if it doesn't work.

**Migration needed**: `sync_map.markup_uploaded` (idempotent
`ALTER TABLE`). Run `npm run migrate`.

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

## Field mapping (status & issue type)

On `/setup`, pick a project to configure how Revizto's statuses/types map
to ACC's. Admin-only, same as the rest of project setup.

- **Status mapping**: Revizto statuses are pulled live from that project's
  actual workflow settings (not guessed) — no docs dependency there. ACC's
  status options are its fixed enum (confirmed from the old app's working
  code, not a guess). Unmapped statuses fall back to the hardcoded default
  in `reviztoService.mapStatusToAcc`, so existing projects don't break.
- **Issue type mapping**: **Revizto stamp** (dropdown, "Category > Stamp
  Title", value stored is the stamp abbreviation — matches what's actually
  on an issue via `stampAbbr`) → **ACC issue type** (dropdown, "Type >
  Subtype", real data from ACC). Both sides are now real dropdowns, no
  free-text entry — this replaced an earlier version that used free-text
  Revizto type entry before we had confirmed field names.

Configured mappings take priority; anything not configured falls back to
the existing hardcoded defaults, so turning this feature on doesn't risk
breaking projects that haven't touched it yet.

**Migration needed**: two new tables, `status_map` and `type_map` (plain
`CREATE TABLE IF NOT EXISTS`, no `ALTER` needed since they're brand new).
Run `npm run migrate`.

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

**Known limitation:** the webhook side (ACC→Revizto) currently only updates
status and the latest comment — not title/description/due date going back
into Revizto. Building that out further requires confirming Revizto's issue
*field* update API (beyond the status-via-diff-comment mechanism we already
have) — flag if you want that built out next.

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
- **ACC → Revizto sync only handles status + latest comment.** Attachments and
  due-date/assignee sync back to Revizto are stubbed as extension points in
  `syncService.handleAccWebhook` — not yet implemented both ways.
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
