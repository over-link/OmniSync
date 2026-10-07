# Multi-company (multi-tenant) architecture — plan

Status: **proposal, nothing built yet** (written 2026-10-01). Today the app is
single-company: one license, one shared sync loop, and every license admin sees
every project. This document describes how company A (5 project slots) and
company B (3 slots, two weeks later) share one app without seeing each other's
data, and how sync traffic is kept fair and fast as the number of companies
grows (target: ~50 companies × several projects each).

Facts below marked *(today)* come from the current code; numbers marked
*(estimate)* are planning figures, not measurements.

---

## 1. Principles

1. **A company is a tenant.** Everything a company owns (projects, users'
   roles, tokens' use, sync data, logs, settings) belongs to exactly one tenant.
2. **Isolation is enforced in layers.** The app scopes every query by tenant,
   the database backs it up (row-level security), and automated tests try to
   break it. One layer being wrong must not leak data.
3. **Sync work is scheduled per project, not per loop.** A slow company can only
   delay itself.
4. **Plans are data, not code.** Slot count, expiry and limits live on the
   tenant record, changed by an operator, never by editing constants.
5. **The tenant is a routing unit.** Code reaches the database through one
   tenant-aware layer, so a very large customer can later be moved to its own
   database ("cell") without rewriting the app.

---

## 2. Roles (who can do what)

| Level | Role | Scope |
|---|---|---|
| Platform | **Operator** (us) | Creates tenants, sets slots/expiry, suspends. Sees metrics, **never customer issue data** by default. Outside any tenant. |
| Tenant | **Primary license admin** | One per tenant; the buyer. Cannot be removed. |
| Tenant | **License admin** | Revizto *License administrator* (role 4+). Creates/pairs projects, manages license admins. |
| Project | **Project admin** | Per project. May *modify* an existing pairing, manage team. |
| Project | **Standard** | Per project. Issues, dashboards. |

A person is one account (email). **Decided (owner, 2026-10-01, latest):**

- **Each license is its own access boundary, even inside one company.** If
  company A holds a US license and an EU license, people are invited to each
  license **separately**: being a member of the US license gives **no** access
  to the EU license, its projects or its people list, and removing someone from
  one doesn't touch the other.
- **Anyone may belong to several licenses** (of the same or of different
  companies), with a separate role in each: license admin, or a member whose
  project roles (project admin / standard) are set per project. A license admin
  of license X may be a standard member of license Y, as long as they are
  **invited** to Y; there is never automatic or inherited access.
- **One role per person per license.**
- **Company (the buyer) is a grouping**, not an access boundary: it owns the
  contract and the list of licenses. Its **account owner (the buyer)** sees
  **only the licenses their company purchased** — never another company's. When a
  license is bought, the operator makes the buyer its **first license admin** (an
  explicit step, still verified against Revizto as License administrator of that
  license); that is what gives them access to the license's projects and people,
  not their being the "owner". Anyone else at the company is invited to each
  license separately, like everyone else.
- **License drop-down (the workspace switcher).** The unit a person works in is a
  **license workspace**. Anyone who belongs to two or more licenses — any role,
  license admins included — gets a **license drop-down at the top of the sidebar,
  above the project drop-down**, labelled "license · company" (e.g. "EU · Company
  A"). It lists only licenses they were invited to (and, for admins, verified on).
  Choosing one re-scopes everything: the project drop-down, Issues, Team,
  Dashboards, Activity Log, License Administration, Project Setup and slot counts.
  The last choice is remembered per user (like the open project today) and the
  active license is part of the session; the server re-checks membership on every
  request. A person in one license never sees the drop-down. Roles can differ per
  license (license admin in one, standard in another) and the menus follow the
  chosen license. (This replaces the earlier "company switcher" idea and the
  earlier statement that a license is only a grouping label.)
---

## 3. Journey — Company A buys a 5-project plan

### 3a. Operator — starting a license once the deal is signed and paid

The **operator** is you or your team: accounts flagged `is_operator`, who can open
a private **operator console** (a new page, built in chunk 4; until it exists this
is done by hand in the database). The license starts here, **only after** the deal
is signed and paid. The app has **no billing**: you confirm payment yourself, and
may record the invoice/contract reference in a note on the license.

**What the operator needs from the customer:** company name, a unique license
name, the plan (project slots and term), a timezone, and the buyer's email. The
customer's **Revizto license is not typed in** — it is tied to the company when
the buyer connects Revizto (the app reads it and checks they are License
administrator on it).

**Steps**
1. **Deal signed and paid** — outside the app.
2. **Open the operator console** (operator accounts only).
3. **Create the company, once**: name and timezone (for polling hours). Never
   duplicate a company for a later purchase.
4. **Add its first license**: a **unique name** (e.g. "Company A – US"), plan = 5
   slots, **start date and expiry date** (expiry = start + the term bought),
   region, optional billing note. Status = active from the start date; the
   expiry clock starts here, not when the buyer first signs in. *(Today: capacity
   5 and the expiry are placeholders in `services/licenseTerms.js`.)*
5. **Invite the buyer** by email → they become the company's **account owner** and
   the license's **first license admin** (an explicit step, still verified against
   Revizto when they connect).
6. **Hand over and check**: the buyer follows 3b; the operator confirms the
   license shows **active** and **0 of 5 slots used**.

**Later operator actions, same screen:** add a further license (a new purchase =
a new, separately named license on the existing company), renew/extend an expiry,
correct slots, suspend, list expired licenses, purge after retention. (Self-serve
sign-up with payment is a possible later replacement for this manual step.)

### 3b. Primary license admin
1. **Accept the invite**: emailed 6-digit code → create password → enter full
   name. *(Today's sign-in flow.)*
2. **My Connections → connect Revizto** (paste access code). The app reads their
   own license role and requires **License administrator or above** on a Revizto
   license; that license is then **bound to the tenant** so no other tenant can
   claim it. A company may bind **several licenses** (e.g. one per region) —
   a license admin adds each further license from License Administration, and
   must be License administrator on it.
3. **Connect ACC** (Autodesk sign-in).
4. **License Administration** shows slots **0 of 5 used** and the expiry date.
   Invite other license admins (they stay *Pending invitation* until they sign in
   and their own Revizto connection proves License administrator).
5. **Create a project** (name only): takes slot 1 of 5. The slot count is checked
   atomically **per tenant**; a 6th project is refused with an upgrade message.
6. **Project Setup → pair it**: choose among *only this tenant's* licenses and
   projects; the Revizto project list shows all projects of the licenses they
   administer, the ACC list only projects where they are project admin. Saving
   requires project admin (or higher) on **both** sides, then registers the ACC
   webhook under the project owner's connection.
7. **Field mapping**: statuses, issue types, ACC custom fields, optional
   auto-sync filters.
8. **Team**: invite project admins and standard users (each must really belong
   to the project in both Revizto and ACC to get in).
9. **Issues**: link & push (admins always; standard users if allowed), or let
   auto-sync-by-filter do it. Dashboards and the Activity Log fill in.
10. **Ongoing**: archive a finished project (frees its slot); to go beyond 5, ask
    the operator to raise the plan.

### 3c. Company B, two weeks later (3 slots)
Identical journey with **no code change and no downtime**:
- Operator creates tenant B (3 slots, its own expiry/timezone) and invites B's
  primary license admin.
- B binds **its own** Revizto license; A and B can never share one.
- B's projects, users, logs and webhooks carry B's `tenant_id`; A cannot see
  them and vice-versa.
- B's sync jobs enter the shared scheduler under B's fairness budget, so B
  neither slows A down nor is slowed by A.

### 3d. Company A buys a second license (3 slots, another region) a month later
- Operator adds the license to company A (bound to the EU Revizto license — or,
  if the company bought another plan for the *same* Revizto license, to that
  one) as a **new license with its own unique
  name** (e.g. "Company A — EU"), **3 slots and its own expiry**. It is never
  merged into the first license, and the same company is never duplicated.
- **Nobody is carried over.** The account owner invites the EU license's admin(s)
  and members **separately** (each must also be a real member of the EU license
  in Revizto). Someone who is already on the US license must be invited again to
  the EU one — until then they can't see it.
- License Administration lists each license with its slots (US 4 of 5, EU 1 of 3),
  expiry and its own admins/members; switching workspace (US ↔ EU) swaps every
  list. An EU expiry pauses only EU projects.
- Sync: each project is its own job; the region is its own rate-limit lane.

**Acceptance checklist when B goes live** (automated where possible):
A's admins list none of B's projects/users/logs; A cannot open a B project by id;
B's webhook events never touch A's rows; A and B slot counts move independently.

---

## 4. Data model changes

New:
- `tenants` (id, name, status, `slot_capacity`, `expires_on`, `timezone`,
  plan limits, created_at)
- `revizto_licenses` (id, tenant_id, `revizto_license_uuid` **UNIQUE**, region)
  — a Revizto license as the app knows it. It belongs to **exactly one company**
  (two companies can never claim the same Revizto license), but it can carry
  **several of the company's licenses (plans)** — see next.
- `tenant_licenses` — "**license**" in the app's own words (the purchased plan):
  (id, tenant_id, **`name`** — unique within the company (case-insensitive),
  `revizto_license_id` → `revizto_licenses` (**not unique**), **`slot_capacity`,
  `expires_on`**). **Each purchase is its own license** (owner, 2026-10-01): a
  company buys one at a time, each with its own name, slot model and duration, and
  a later purchase is **a new, separately named license** — never a top-up or a
  stacked term on an existing one. **Several licenses of the same company may
  apply to the same Revizto license** (owner, 2026-10-01); each keeps its own
  slots, expiry, members and projects.
  *Terminology:* "license" below always means this purchased plan; the Revizto
  side is written "Revizto license".
- `license_members` (tenant_license_id, user_id, role: `license_admin` |
  `member`) — the **access boundary**. UNIQUE (tenant_license_id, user_id): one
  role per person per license; a person may have rows on many licenses. A row is
  created only by an explicit invite from an admin **of that license**. License
  admins are verified against *that* license in Revizto (License administrator).
- `tenants` additionally has an **account owner** (primary license admin) used
  for billing/contract screens; this role does not by itself grant data access.
- `users.role` (global) goes away; the operator is a flag on the user, outside
  every company. Project roles stay in `project_members`, whose project sits on
  a license the user has a `license_members` row for (composite FK), so a
  project role can't exist without membership of its license.

**Consequences of several licenses sharing one Revizto license**
- **Projects belong to one license.** A project is created under a license (name
  only, using one of *that license's* slots) and paired with a Revizto project
  inside the license's Revizto license.
- **Licenses may share a Revizto license, but an ACC project can only be fed by
  ONE Revizto project** (owner, 2026-10-01). Every Revizto project in the Revizto
  license is selectable under any of the company's licenses on it, but an **ACC
  project can be actively paired to only one Revizto project in the whole app**
  — that covers the identical pair (the same two projects paired twice) and also
  two *different* Revizto projects pointing at the same ACC project, either of
  which would write issues from several sources into one place and create
  duplicates. Pairing one Revizto project with *different* ACC projects is
  allowed (the team's choice), as is any other combination.
  - **At pairing:** refused with "This ACC project is already paired with a
    Revizto project under <license name>. Archive or re-pair that one first." (If
    the existing pairing belongs to another company the name is withheld:
    "…already paired by another account.")
  - **What counts as active:** the project isn't archived and its license isn't
    expired or suspended. So a license can expire (or a project be archived) and
    the same ACC project be **re-paired under the new license** so syncing
    continues.
  - **When an old pairing comes back** (e.g. the expired license is renewed while
    the ACC project is now paired under the new license): the returning project
    stays **paused with a notice** until the team archives or re-pairs one of the
    two; the other keeps syncing. Nothing is deleted.
  - **Enforced in the database, not just the page:** `projects.sync_active` is
    kept in step with license/archive state, and a **partial unique index on
    (`acc_project_id`) WHERE sync_active** makes a second active pairing of the
    same ACC project impossible, even from two admins saving at once.
  - Project Setup may also annotate a Revizto project that is paired elsewhere
    ("also paired under <license name>"); that notice never disables it.
- **Separate boundaries still hold.** Members are invited per license, so a person
  invited only to license 1 can't see license 2's projects or people even though
  both sit on the same Revizto license (and even though, in Revizto itself, a
  License administrator would see every project there). This is deliberate.
- **License admins are verified against the Revizto license** the license is
  bound to: License administrator there is enough for every license on it, but
  they are only an admin of the licenses they were invited to.
- **Expiry, suspension and slots are per license**: when license 1 expires, only
  its projects pause; license 2's carry on, even on the same Revizto license.
- **Sync lanes** stay per Revizto license/region (rate limits and tokens are
  shared by what's on the same Revizto license), with fairness between the
  licenses on it.
- **Otherwise what gets paired is the team's choice:** the app doesn't restrict
  other combinations. Still checked, as security: a Revizto project's company
  must match the license's company, and the person pairing must be project admin
  of both projects (as today).

Add `tenant_id` and `tenant_license_id` (NOT NULL, indexed) to: `projects`, `invites`, `invite_links`,
`audit_log`, per-tenant settings (see below). Child tables (`sync_map`,
`status_map`, `type_map`, …) already hang off `project_id`; they inherit the
tenant through the project and get a composite FK so a row can never point to a
project of another tenant.

Settings that are **global today** (sync paused, 24/7 polling, polling hours in
Pacific time) become **per tenant**, plus a platform-wide pause for the
operator.

`licenseTerms` reads the tenant's row instead of constants; the advisory lock
key becomes `hashtext('project_slots:' || tenant_license_id)`. Slots are
counted **per license** (each license is bought with its own slot count); the
company total is shown as a sum on the account-owner screen.

### License expiry

**Decided (owner, 2026-10-01).** `tenant_licenses.expires_on` is the date the
license (the app plan bought for that Revizto license) ends. There is **no grace
period**: from the day after it, nobody can use the license. What people see
changes in three phases:

| Phase | When | In the license drop-down | Syncing / use | Data |
|---|---|---|---|---|
| Active | up to and including `expires_on` | normal | normal | live |
| **Expired (greyed)** | the **30 days** after `expires_on` | **shown greyed out**; choosing it opens a plain page: **"License has expired. Contact your administrator."** | stopped: no opening, linking, pairing or syncing; ACC webhook events ignored; slots stop counting | kept |
| **Gone** | after those 30 days | **falls off every list** (drop-down, admin pages, project lists) for everyone | stopped | kept hidden |
| Purgeable | **90 days after `expires_on`** (retention) | — | — | the operator may delete it permanently (tenant lifecycle, section 5 point 8) |

Details:
- **All syncing for an expired license is paused until it is active again**
  (owner, 2026-10-01) — every path, not just the 2-minute poll:
  - the scheduler enqueues no jobs for its projects, the nightly full check
    skips them, and bulk/manual "Link & push" and unlink are refused;
  - ACC webhook events for its projects are **ignored** (dropped, as they are
    today while sync is paused), and the hourly webhook health check must
    **not** re-register or reactivate those hooks while it's expired;
  - auto-sync-by-filter and the field-attribution/comment/attachment polls stop;
  - background token keep-alive **continues** for its connections during the
    90-day retention window, so a renewal doesn't force everyone to reconnect
    (Autodesk revokes refresh tokens after ~3 weeks idle).
- **On renewal, syncing resumes automatically** — within minutes, no admin
  action — **with a reconcile pass first** (decided by the owner, 2026-10-01).
  Today's nightly "full check" pushes Revizto's current state over ACC for every
  linked issue, so an ACC edit made during the pause (its webhook was dropped)
  would be overwritten. Instead, the first pass after any pause (expiry renewal
  or the over-limit suspension below) compares **both sides' last-modified time
  per linked issue and syncs the newer one**, then normal change-detection takes
  over. Conflicts where both sides changed are resolved by the newer timestamp
  and written to the Activity Log so nothing is silently lost.
- **Renewal restores everything.** The operator extends `expires_on`: in the
  greyed phase it simply turns normal again; after it's gone (but within
  retention) it reappears. Syncing resumes from where it stopped and the usual
  change detection catches up. Nothing is lost inside the 90 days.
- **One message for every user** (owner, 2026-10-01): everyone on the license —
  members, project admins, license admins and the primary license admin alike —
  sees exactly **"License has expired. Contact your administrator."**
- **Someone whose only license has expired** lands on that same message page
  after signing in (for the first 30 days); after that they get a plain "you
  don't have access to any license" message. People with other licenses just
  carry on in those and still see the greyed one for 30 days.
- **Operator and account owner:** the operator console always lists expired
  licenses (for renewals and purges); the account owner sees an "expired — renew"
  notice on the account screen.
- **No window for expired syncing:** the scheduler checks the phase before it
  enqueues any project, so an expired license never syncs.
- **Retention is 90 days counted from `expires_on`** (confirmed by the owner):
  greyed for 30 days, hidden for the remaining ~60, then purgeable.

### Over the slot limit

**Decided (owner, 2026-10-01): a license that is over its slot count stays
suspended until the count is brought back under the limit.** This can happen
when the operator lowers a license's `slot_capacity` (a downgrade) below its
current number of non-archived projects.

- **Suspended means all syncing is paused** (same rules as an expired license,
  including webhooks ignored and the hourly webhook check not repairing hooks).
  Nothing is deleted.
- **What people see:** the license shows greyed in the drop-down with
  **"License is suspended. Contact your administrator."** (owner-confirmed wording). Everyone except license admins and the account owner is
  stopped at that message.
- **How it's fixed:** a license admin (or the operator) brings the count down by
  **archiving or deleting projects** on License Administration — the only page
  license admins can use while the license is suspended; or the operator raises
  `slot_capacity`. The check is re-evaluated on every such change.
- **Back under the limit:** the license reactivates automatically, syncing resumes
  with the same reconcile pass as after a renewal, and nothing else is required.
- Creating or unarchiving a project while at the limit stays refused (today's
  "No available project slots remain."), so a license never goes over by itself;
  only a downgrade can put it over.
- If a license is both expired and over its limit, **expiry** is what's shown
  until it is renewed.

---

## 5. Keeping data secure and private

1. **Tenant context from the session, never from the request.** Middleware
   resolves the active **license workspace** (`req.license`, plus its company)
   from the signed-in user's selected membership (the workspace switcher, for
   people in several); the server checks the membership on every request, and no
   route accepts a tenant or license id as the scope. Switching workspace
   changes every scope at once, and a person's role in one license is never
   consulted when acting in another.
   The Revizto license-role check for a license admin is **per license**: they
   must be License administrator on *that* Revizto license (verified at
   sign-in/connect as today; pending until it passes).
   Row-level security therefore filters on the license id (and tenant id).
2. **One data-access layer.** Queries go through helpers that require a tenant;
   a lint/CI check fails on raw queries against tenant tables.
3. **Row-level security as a backstop.** *(Built — chunk 6, switch `RLS_MODE`.)*
   Per request the open **license** is set as `app.license_id`; RLS policies on
   the license-owned tables filter by it, using a database role (`app_rls`) that
   cannot bypass RLS. A forgotten `WHERE` returns nothing of another license's
   instead of leaking. How it works:
   - **Two pools** (`db/pool.js`). The *unrestricted* pool (the app's normal
     Supabase user, which bypasses RLS) is used for sign-in, sessions, tokens,
     the poller, webhooks, migrations, the operator console and anything that
     must look across licenses (`pool.admin`). The *restricted* pool runs as
     `app_rls`. A request is handed to the restricted pool once its license is
     known (`routes/auth.js`: `requireLogin` / `requireProjectRole` / ...);
     `pool.query()` picks the right pool by itself, so route code is unchanged.
   - **Policies** (`schema.sql`): `projects`, `license_members`,
     `tenant_licenses` (and `tenants`) by license; `users` only for members of
     the open license; everything that belongs to a project (links, mappings,
     invite links, Activity Log, project members) through its project. The
     restricted role has **no access at all** to tokens, sessions, password codes,
     app settings or Revizto licenses, and may only add invitations.
   - **Safe by default.** `RLS_MODE` unset/`off` = exactly the old behaviour.
     `RLS_MODE=on` runs a self-test at start-up and, if the role isn't set up,
     logs a loud error and carries on *without* restriction rather than failing.
     Every refusal of the restricted role is logged (`[rls] The restricted role
     was refused ...`) so a query that needs the unrestricted pool shows up
     even where the caller swallows errors.
   - **Limits, honestly.** It guards against forgotten filters, not against SQL
     injection: `app_rls` is entered with `SET ROLE`, so injected SQL could
     `RESET ROLE`. (Hardening later: a separate login role with its own
     connection string.) The unrestricted pool is still trusted code.
   - **Connections.** Supabase's session pooler allows **15 connections in total**;
     with RLS on each pool defaults to 5 (`DB_POOL_MAX`). A deploy briefly runs
     the old and new instance together.
4. **Cross-tenant tests** run in CI: seed A and B, then for every API route
   assert that A's session gets 404/403 for B's ids and never B's rows in lists.
5. **Webhooks.** An ACC event resolves hook id → project → tenant. **Verifying
   Autodesk's signature is a TODO today and must be done before more than one
   company is on the app.**
6. **Secrets.** Revizto/ACC tokens are stored per user; encrypt them at rest
   with a key outside the database (and rotate), and never log them.
   *(Verify current at-rest handling as part of phase 1.)*
7. **Operator access** to customer data is off by default; any support
   access is explicit, time-boxed and audit-logged.
8. **Tenant lifecycle.** Suspend (sync stops, logins blocked), export, and
   delete (cascade + token revocation + webhook removal) are defined
   operations, not ad-hoc SQL.

---

## 6. Optimizing sync traffic

Problem *(today)*: one 2-minute cycle visits every project **sequentially** in one
process under one lock; Revizto has no webhooks so it must be polled; calls use
the project owner's tokens; retries cover only transient gateway errors
(502/503/504 on idempotent calls, `services/httpRetry.js`) — **429 / Retry-After
is not handled**.

Design:
1. **Separate the worker from the web app.** The poller moves to its own
   background service (same code base). Web latency is no longer affected by
   sync load, and workers scale independently.
2. **A job queue in Postgres** (e.g. pg-boss/graphile-worker; Redis only if
   needed later). A scheduler enqueues one **sync job per project**; workers
   pull jobs.
3. **Fairness.** Per-tenant concurrency cap (e.g. 2), a global cap (e.g. 8–12),
   oldest-last-run first, small random jitter so jobs don't all start at :00.
   A tenant with a huge project fills only its own lanes.
4. **Adaptive frequency.** Active projects every ~2 min; idle ones back off (5 →
   10 min) and snap back on activity; ACC→Revizto stays event-driven via
   webhooks; the nightly full check stays but is staggered across tenants.
5. **Rate-limit awareness.** Token-bucket per owner connection and per
   provider; honour `Retry-After`/429 with exponential back-off; a throttled
   project yields its worker instead of blocking it.
6. **Cheap cycles.** Keep today's bulk change-detection (unchanged issues cost
   no calls). Cache per-project lookups; make auto-sync-by-filter incremental
   instead of re-reading the whole Revizto issue list each cycle.
7. **Long jobs off the request path.** Bulk "Link & push" becomes a queued job
   with progress shown on the page.
8. **Per-tenant polling hours/timezone** (today fixed Pacific, 6 AM–6 PM).
9. **Metrics.** Per project: cycle duration, issues scanned/changed, API calls,
   throttles, errors; per tenant roll-ups; alert on cycles longer than their
   interval or growing queue age. Show a "last synced" time to users.

*(estimate)* 50 tenants × 5 projects = 250 projects. At ~10 s per project cycle,
sequential = ~40 min per pass (unworkable); 10 workers ≈ 4 min per pass, and
idle back-off pulls busy projects under 2 min.

---

## 7. Scaling path

| Stage | Shape | Trigger to move on |
|---|---|---|
| 1 (now → ~10 companies) | One web service + one worker, one Postgres, tenancy + RLS | Queue age or cycle time alert |
| 2 (~10–50) | 2+ workers, connection pooler (PgBouncer), read replica or cached aggregates for Dashboards, `audit_log` partitioned/archived | DB CPU/connections, slow dashboards |
| 3 (50+ or a large/regulated customer) | **Cells**: a tenant→database/worker-pool map; big or sensitive tenants get a dedicated cell; the rest share | Data-residency/contract needs, noisy neighbour |

Because all access goes through the tenant-aware data layer (principle 5),
stage 3 is configuration plus a migration, not a rewrite.

---

## 8. Build order

**Phase 0 — safety first (small).** ACC webhook signature verification; at-rest
token encryption check; cross-tenant test harness skeleton.

**Phase 1 — tenancy (the gate to onboarding a second company).**
`tenants` + `tenant_licenses` + `license_members`; move today's data under tenant #1; scope every
query/page (license admins, project lists, Activity Log, Dashboards, Team);
per-tenant slots/expiry; bind Revizto license to tenant; operator console to
create tenants and set slots; RLS; CI isolation tests.
*Exit:* two seeded tenants cannot see or affect each other through any route.

**Phase 2 — fair sync.** Split worker; job queue; per-project jobs with
per-tenant/global caps; rate-limit handling; per-tenant timezone/pause;
metrics and the "last synced" display.
*Exit:* a deliberately huge test project doesn't delay another tenant's cycle.

**Phase 3 — scale and polish.** Background bulk link; incremental auto-sync;
dashboard aggregates; self-service plan upgrades/billing hooks; cell routing.

**Onboarding company B before phase 1 is done?** Use a **separate deployment**
for B as a stopgap (own app + database), knowing it must be merged into the
shared app later.

---

### Phase 1 breakdown (the gate to onboarding a second company)

**Goal:** a second company can be created and used without any chance of seeing
or affecting the first. **Not in phase 1:** the worker split, job queue, fair
scheduling and rate-limit work (phase 2); the only sync change is "skip
expired/suspended licenses".

**A. Database (one backwards-compatible migration, then backfill)**
- New: `tenants`, `revizto_licenses`, `tenant_licenses` (name, slots, expiry,
  state), `license_members`; `users.is_operator`; `users.current_license_id`
  (next to today's `current_project_id`).
- Add `tenant_id` / `tenant_license_id` to `projects`, `invites`,
  `invite_links`, `audit_log`; add `projects.sync_active` with the partial
  unique index on `acc_project_id`. Child tables (`sync_map`, `status_map`,
  `type_map`, `acc_status_map`, `user_map`, `auto_sync_filters`,
  `acc_issue_numbers`) already hang off `project_id` and inherit.
- `app_settings` (sync paused, 24/7 polling, last full check) becomes per license
  plus an operator-level global pause.
- **Backfill:** today's data becomes company #1 with one license (slots and expiry
  from the current placeholders in `licenseTerms.js`: 5 and 2027-07-15), bound to
  the Revizto license already stored on its projects; today's primary license
  admin becomes account owner + license admin; other license admins become
  license admins; everyone else a member; `project_members` unchanged.
  `users.role` is kept read-only until phase 1 ships, then dropped.

**B. Access layer** (`services/access.js`, `membership.js`,
`currentProject.js`, `routes/auth.js`)
- `getAccess(userId, licenseId)`: roles come from `license_members` +
  `project_members` for the *active license*; "license admins see every project"
  becomes "see every project **of their license**".
- Session carries the active license; `requireLogin` loads it and refuses a
  license the person isn't a member of; no route accepts a license/company id as
  scope. The Revizto license-role check (pending/denied flow) runs per license.
- One `licenseState()` function (active / expired-greyed / gone / suspended)
  used by access, the drop-down, scheduler, webhooks and webhook-health.

**C. Routes and queries to scope** (every one gets a cross-license test)
`routes/index.js` (projects list, pairing, status/type maps, issues board,
settings), `routes/license.js` (admins, projects, archive/delete, slots),
`routes/team.js` (team, invites, links, owner handoff), `routes/auth.js`
(sign-in gate, invites), plus the services with project-spanning reads:
`dashboards.js`, `auditLog.js` / Activity Log, `currentProject.js`,
`licenseTerms.js` (slots counted and locked **per license**).

**D. Pairing**
Licenses list = the company's own; the Revizto/ACC project lists are as today;
admin checks unchanged (project admin of both sides). New: the active-ACC-project
guard, `sync_active` upkeep, the "already paired" messages, and the
re-pair-after-expiry flow.

**E. Pages**
- `nav.js`: **license drop-down** above the project drop-down (anyone in 2+
  licenses); greyed entry + the expired/suspended message page.
- **License Administration**: per-license slots/expiry, admins and members, projects.
- **Project Setup**, **Team**, **Dashboards**, **Activity Log**, **My Connections**:
  scoped to the active license.
- New **operator console**: create a company and its first license (name, Revizto
  license, slots, expiry, timezone), invite the account owner, add further
  licenses, renew/extend, change slots, suspend, list expired.

**F. Sync touch-points (minimal)**
`pollAllProjects` skips projects whose license isn't active (or whose pairing is
paused by the duplicate guard); the ACC webhook handler and `webhookHealth` ignore
inactive ones; token keep-alive continues; the first sync after any pause runs the
reconcile pass.

**G. Security and tests**
Row-level security on `app.license_id`; CI harness that seeds two companies and
three licenses (one expired, one suspended) and asserts, for every route, that a
session of one license gets 403/404 or empty lists for another's ids.

**H. Rollout**
Ship migration + backfill first (no behaviour change, single company); then the
scoped access layer behind a "multi-license" switch that stays off until a second
license exists; run the leak tests in CI and on a staging copy; then turn it on
and create company #2 from the operator console. Rollback = switch off (data is
unchanged). **Exit:** two seeded companies cannot see or affect each other
through any page or API route, and slot/expiry/suspension behave as specified.

**Rough size:** large — most of the work is the careful scoping of existing
routes and tests (C, G), not new features.

## 9. Open decisions (need the owner's call)

1. ~~Can one person belong to several companies?~~ **Decided:** yes, for every
   role; license admins too (e.g. regional licenses of one company, or admin of A
   and standard member of B) — memberships only by explicit invite.
2. Who creates tenants — only us (operator console), or self-serve sign-up with
   payment? (Plan assumes operator-created first.)
3. What does a plan limit besides project slots — users, issues, sync frequency?
4. **Decided:** no grace period; an expired license shows greyed with "License
   has expired. Contact your administrator." for 30 days, then falls off every
   list; all syncing is paused; data is retained 90 days from expiry; renewal
   restores it with a last-modified reconcile pass. A license **over its slot
   limit stays suspended** until the count is back under the limit (license
   admins can only archive/delete projects meanwhile). The suspended message is
   "License is suspended. Contact your administrator."
5. **Decided:** a company may have several Revizto licenses; slots, expiry and
   **membership are per license** (separate invites). The account owner sees only
   the licenses their company purchased, and gets access to each as its first
   license admin. A **license drop-down is enough** — no combined cross-license
   project view for now.
6. Any customer needing a dedicated database or data residency from day one?
7. Do we need a customer-visible status/"last synced" page per tenant?
