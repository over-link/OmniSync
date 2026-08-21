/**
 * services/reviztoService.js
 * Revizto Workspace API v5 calls, per-user token via authManager, plus
 * the Revizto <-> ACC field mapping logic carried over from the old app
 * (title/description/status/dueDate/assignee, plus the stamp-category ->
 * ACC subtype keyword matching).
 */
const axios = require('axios');
const FormData = require('form-data');
const { getValidReviztoToken } = require('./authManager');

function baseUrl(region) {
  return `https://api.${region}.revizto.com/v5`;
}

// NOTE: `region` here is the region of the DATA being requested (e.g. a
// project's region), while authManager.getValidReviztoToken looks up the
// region the calling user's own token was issued in. These are expected to
// match in normal use (a user's Revizto account and the projects they
// access are on the same regional API) — if they diverge, Revizto's own
// -205 error ("access token obtained in a different region") will surface
// it rather than failing silently.
async function request(userId, region, method, url, options = {}) {
  const token = await getValidReviztoToken(userId);
  try {
    const { data } = await axios({
      method,
      url: `${baseUrl(region)}${url}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
      params: options.params || {},
      data: options.body,
    });
    return data;
  } catch (err) {
    const msg = err.response?.data?.message || '';
    const result = err.response?.data?.result;
    if (result === -206 || msg.includes('-206')) {
      // Access token expired mid-flight — authManager's refresh on next call
      // will handle it; surface a clear retry-once here.
      const newToken = await getValidReviztoToken(userId);
      const { data } = await axios({
        method,
        url: `${baseUrl(region)}${url}`,
        headers: { Authorization: `Bearer ${newToken}`, 'Content-Type': 'application/json', ...options.headers },
        params: options.params || {},
        data: options.body,
      });
      return data;
    }
    throw err;
  }
}

// ─── Issues ───────────────────────────────────────────────────────

// clashAndLocationFields (level/zone/room/area/etc.) is gated behind this
// explicit flag — confirmed from real docs: NOT included by default even
// with sendFullIssueData: true. Requested on every issue fetch since the
// level/zone -> ACC mapping needs it unconditionally.
const ADDITIONAL_FIELDS = ['appendClashAndLocationFields'];

async function getIssues(userId, region, projectUuid, filters = {}) {
  const allIssues = [];
  let page = 0;
  let totalPages = 1;
  while (page < totalPages) {
    const response = await request(userId, region, 'POST', `/project/${projectUuid}/issue-filter/filter`, {
      body: { page, limit: 100, sendFullIssueData: true, alwaysFiltersDTO: [], additionalFields: ADDITIONAL_FIELDS, ...filters },
    });
    const issues = response.data?.data || [];
    allIssues.push(...issues);
    totalPages = response.data?.pages || 1;
    page++;
  }
  return allIssues;
}

async function getIssue(userId, region, projectUuid, issueId) {
  const response = await request(userId, region, 'POST', `/project/${projectUuid}/issue-filter/filter`, {
    body: {
      page: 0,
      limit: 1,
      sendFullIssueData: true,
      alwaysFiltersDTO: [{ type: 'id', expr: 1, value: [String(issueId)] }],
      additionalFields: ADDITIONAL_FIELDS,
    },
  });
  const issues = response.data?.data || [];
  if (!issues.length) throw new Error(`Revizto issue ${issueId} not found`);
  return issues[0];
}

let _workflowSettingsCache = {};

/**
 * Full workflow settings: { workflows[], types[], statuses[] } — confirmed
 * from real docs. Cached per project since this rarely changes.
 */
async function getWorkflowSettings(userId, region, projectUuid) {
  if (_workflowSettingsCache[projectUuid]) return _workflowSettingsCache[projectUuid];
  const response = await request(userId, region, 'GET', `/project/${projectUuid}/issue-workflow/settings`);
  const settings = response.data || { workflows: [], types: [], statuses: [] };
  _workflowSettingsCache[projectUuid] = settings;
  return settings;
}

/**
 * Simple { name: uuid } map for display purposes (e.g. the admin mapping
 * dropdown) — NOT safe to use for writing a status to a specific issue,
 * since a project with multiple workflows can have multiple statuses
 * sharing the same name but different UUIDs (see updateIssueStatus,
 * which resolves this correctly via the issue's own workflow).
 */
async function getStatusMap(userId, region, projectUuid) {
  const settings = await getWorkflowSettings(userId, region, projectUuid);
  const map = {};
  for (const s of settings.statuses || []) {
    if (!s.deletedAt) map[s.name] = s.uuid;
  }
  return map;
}

/**
 * An issue's workflow is determined by its issue TYPE (customType), not
 * the issue directly — each type has one workflowUuid. Returns null if
 * the issue has no customType set or it doesn't resolve to a known type.
 */
function resolveIssueWorkflowUuid(issue, settings) {
  const typeUuid = issue.customType?.value || null;
  const type = (settings.types || []).find((t) => t.uuid === typeUuid);
  return type?.workflowUuid || null;
}

/**
 * Human label for a workflow — confirmed from real Revizto docs: each
 * workflow object has its own required `name` field (e.g. "My workflow").
 * Returns null only if the workflow can't be found at all, so the caller
 * can apply its own numbered fallback rather than showing a blank label.
 */
function getWorkflowLabel(workflowUuid, settings) {
  const workflow = (settings.workflows || []).find((w) => w.uuid === workflowUuid);
  return workflow?.name || null;
}

/**
 * Every non-deleted status name that actually belongs to a given
 * workflow (cross-referencing the workflow's own status UUID list
 * against the project-wide status list for names, same pattern as
 * _resolveStatusUuidForIssue). Used to auto-map a custom Revizto status
 * to an ACC "Revizto Status" option when their names match exactly — the
 * same zero-config idea as the 4 canonical statuses, extended to any
 * custom status whose name happens to already match an ACC option.
 */
function getWorkflowStatusNames(workflowUuid, settings) {
  const workflow = (settings.workflows || []).find((w) => w.uuid === workflowUuid);
  if (!workflow) return [];
  const statusNameByUuid = new Map((settings.statuses || []).filter((s) => !s.deletedAt).map((s) => [s.uuid, s.name]));
  return [
    ...new Set(
      (workflow.statuses || []).filter((s) => !s.deletedAt).map((s) => statusNameByUuid.get(s.uuid)).filter(Boolean)
    ),
  ];
}

/**
 * Resolves a target status NAME to the correct UUID for a SPECIFIC
 * issue, respecting which workflow actually governs it. Each workflow
 * only recognizes a subset of the project's overall status list, and two
 * different workflows can define a same-named status with different
 * UUIDs — so once the workflow IS known, a match must belong to it; we
 * never fall through to a random project-wide match by name; that risks
 * silently resolving to a status from an unrelated workflow, which
 * Revizto's API rejects with "workflow does not connect to status" (or
 * worse, could point the issue at the wrong entity if a name happens to
 * be shared). The project-wide fallback only kicks in when the workflow
 * itself couldn't be resolved at all (e.g. issue has no customType set).
 */
async function _resolveStatusUuidForIssue(userId, region, projectUuid, issue, statusName) {
  const settings = await getWorkflowSettings(userId, region, projectUuid);
  const workflowUuid = resolveIssueWorkflowUuid(issue, settings);
  const workflow = workflowUuid ? (settings.workflows || []).find((w) => w.uuid === workflowUuid) : null;

  if (workflow) {
    const validUuids = new Set((workflow.statuses || []).filter((s) => !s.deletedAt).map((s) => s.uuid));
    const match = (settings.statuses || []).find((s) => s.name === statusName && validUuids.has(s.uuid));
    return match?.uuid || null;
  }

  // Workflow couldn't be resolved at all — fall back to any project-wide
  // match by name, better than refusing outright.
  const fallback = (settings.statuses || []).find((s) => s.name === statusName && !s.deletedAt);
  return fallback?.uuid || null;
}

/**
 * Posts a "diff" comment to Revizto — the proven mechanism (confirmed
 * working for status) for writing a field change. `diff` is an object
 * like { fieldName: { old, new } }. Includes a no-op guard: Revizto's API
 * rejects an empty diff (confirmed from real testing — "Diff can not be
 * empty"), so callers should avoid calling this when old === new, but as
 * a backstop this also skips posting if diff has no actual keys.
 */
async function _postDiffComment(userId, region, projectUuid, issueUuid, diff, reporterEmail) {
  const commentUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

  const form = new FormData();
  form.append('projectUuid', projectUuid);
  form.append('issueUuid', issueUuid);
  form.append('comments', JSON.stringify([{ type: 'diff', uuid: commentUuid, reporter: reporterEmail, diff }]));

  const token = await getValidReviztoToken(userId);
  const { data } = await axios.post(`${baseUrl(region)}/comment/add`, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
  });
  const commentResult = data?.data?.[0]?.result;
  if (commentResult !== undefined && commentResult !== 0) {
    console.warn('[revizto] diff comment failed:', JSON.stringify(data));
  }
  return data;
}

/**
 * Returns { ok: true } on a successful write, { ok: true, noop: true }
 * when the issue is already on that status, or { ok: false, reason }
 * when newStatusName doesn't resolve to a status belonging to this
 * issue's own workflow — callers should surface `reason` as a visible
 * sync warning rather than treat it the same as a silent no-op.
 */
async function updateIssueStatus(userId, region, projectUuid, issueId, newStatusName, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const oldStatusUuid = issue.customStatus?.value || null;

  const newStatusUuid = await _resolveStatusUuidForIssue(userId, region, projectUuid, issue, newStatusName);
  if (!newStatusUuid) {
    const reason = `Revizto status "${newStatusName}" isn't part of this issue's workflow — skipped.`;
    console.warn('[revizto]', reason);
    return { ok: false, reason };
  }
  if (oldStatusUuid === newStatusUuid) return { ok: true, noop: true }; // avoid empty-diff rejection

  await _postDiffComment(userId, region, projectUuid, issue.uuid, { customStatus: { old: oldStatusUuid, new: newStatusUuid } }, reporterEmail);
  return { ok: true };
}

/**
 * Updates an issue's assignee. UNCONFIRMED: extrapolated from the proven
 * customStatus diff pattern — assignee is a plain email (like customStatus
 * is a plain UUID), so the same { fieldName: { old, new } } shape is a
 * reasonable bet, but this hasn't been confirmed against real Revizto
 * docs the way status was. Test and report back if it doesn't work.
 */
async function updateIssueAssignee(userId, region, projectUuid, issueId, newAssigneeEmail, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const oldAssignee = unwrap(issue.assignee) || null;
  if (oldAssignee === newAssigneeEmail) return null; // no-op
  return _postDiffComment(userId, region, projectUuid, issue.uuid, { assignee: { old: oldAssignee, new: newAssigneeEmail } }, reporterEmail);
}

/**
 * Updates an issue's watchers (full replacement, not additive). Same
 * UNCONFIRMED caveat as updateIssueAssignee — extrapolated pattern, not
 * confirmed docs.
 */
async function updateIssueWatchers(userId, region, projectUuid, issueId, newWatcherEmails, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const oldWatchers = unwrap(issue.watchers) || [];
  const sameSet =
    oldWatchers.length === newWatcherEmails.length && oldWatchers.every((w) => newWatcherEmails.includes(w));
  if (sameSet) return null; // no-op
  return _postDiffComment(userId, region, projectUuid, issue.uuid, { watchers: { old: oldWatchers, new: newWatcherEmails } }, reporterEmail);
}

/**
 * Updates an issue's priority (ACC -> Revizto direction, for the
 * bidirectional Issue Priority mapping). Same UNCONFIRMED caveat as
 * updateIssueAssignee/updateIssueWatchers — extrapolated from the proven
 * customStatus diff pattern (priority is a plain top-level field, same
 * shape as assignee), not confirmed against real Revizto write docs. Test
 * and report back if a priority change in ACC doesn't show up in Revizto.
 */
async function updateIssuePriority(userId, region, projectUuid, issueId, newPriority, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const oldPriority = unwrap(issue.priority) || null;
  if (oldPriority === newPriority) return null; // no-op
  return _postDiffComment(userId, region, projectUuid, issue.uuid, { priority: { old: oldPriority, new: newPriority } }, reporterEmail);
}

/**
 * Updates an issue's deadline (due date) — ACC -> Revizto direction. Same
 * UNCONFIRMED caveat as priority/assignee/watchers — extrapolated diff
 * pattern, not confirmed against real Revizto write docs. ACC's dueDate is
 * date-only (no time component); Revizto's raw deadline is a full
 * datetime string ("YYYY-MM-DD HH:MM:SS", confirmed format from real data
 * elsewhere in this file).
 *
 * Anchored at NOON, not midnight — confirmed by real testing: writing
 * midnight ("00:00:00") showed up a day EARLY in Revizto (an ACC due date
 * of Aug 14 displayed as Aug 13), a classic timezone-boundary bug — some
 * layer between here and Revizto's display is shifting the timestamp by a
 * few hours, and at midnight that shift crosses into the previous day.
 * Noon gives up to +/-12 hours of slack in either direction before the
 * date portion could roll over, without needing to know exactly which
 * layer (transport, Revizto's storage, or its display) is doing the
 * shifting.
 *
 * The no-op check compares only the date portion, so a same-day value
 * with a different time-of-day isn't mistaken for a real change.
 */
async function updateIssueDeadline(userId, region, projectUuid, issueId, newDueDate, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const oldDeadline = unwrap(issue.deadline) || null;
  const oldDatePart = oldDeadline ? oldDeadline.slice(0, 10) : null;
  if (oldDatePart === newDueDate) return null; // no-op, already this date
  const newDeadline = `${newDueDate} 12:00:00`;
  return _postDiffComment(userId, region, projectUuid, issue.uuid, { deadline: { old: oldDeadline, new: newDeadline } }, reporterEmail);
}

/**
 * Updates an issue's title — ACC -> Revizto direction, the missing half of
 * the title mapping (Revizto -> ACC is a direct copy in toAccIssue). Same
 * UNCONFIRMED caveat as priority/assignee/watchers/deadline above:
 * extrapolated from the proven customStatus diff pattern (title is a
 * plain top-level string field, same shape as assignee), not confirmed
 * against real Revizto write docs. Test and report back if a title change
 * in ACC doesn't show up in Revizto.
 */
async function updateIssueTitle(userId, region, projectUuid, issueId, newTitle, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const oldTitle = unwrap(issue.title) || null;
  if (oldTitle === newTitle) return null; // no-op
  return _postDiffComment(userId, region, projectUuid, issue.uuid, { title: { old: oldTitle, new: newTitle } }, reporterEmail);
}

async function addComment(userId, region, projectUuid, issueId, text, reporterEmail) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const commentUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  const form = new FormData();
  form.append('projectUuid', projectUuid);
  form.append('issueUuid', issue.uuid);
  form.append('comments', JSON.stringify([{ type: 'text', uuid: commentUuid, reporter: reporterEmail, text }]));

  const token = await getValidReviztoToken(userId);
  const { data } = await axios.post(`${baseUrl(region)}/comment/add`, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
  });
  return data;
}

const _MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

/**
 * Uploads a file to a Revizto issue — either as a real markup update
 * (asMarkup: true, image files only — Revizto's own docs confirm only
 * .png/.jpg/.jpeg are accepted, up to 38MB) or as a generic file
 * attachment comment (asMarkup: false, anything except .exe/.dmg, up to
 * 38MB) — confirmed shape from Revizto's own "Add issue comments" docs:
 * multipart/form-data with the file's bytes in a `file_<commentUuid>`
 * field alongside the comments JSON array. For a markup update, `markup`
 * is a REQUIRED array[string] field — confirmed from Revizto's own
 * "Markup update" comment schema: "For the method to work correctly,
 * provide an empty array."
 *
 * Confirmed by real testing: this correctly creates a markup-type comment
 * with a visible thumbnail in the issue's feed, but does NOT make the
 * image become the large image shown in Revizto's markup editor — that
 * likely requires actual viewpoint/pin data only created when a person
 * draws directly in Revizto's own client, not reachable via this
 * endpoint. By design (see pollAccAttachmentsForProject), an image is
 * pushed as BOTH a markup update (thumbnail in the feed) AND a plain file
 * attachment (the real, downloadable original) — not one or the other.
 */
async function addAttachment(userId, region, projectUuid, issueId, fileBuffer, fileName, reporterEmail, { asMarkup = false } = {}) {
  const issue = await getIssue(userId, region, projectUuid, issueId);
  const commentUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const mime = _MIME_BY_EXT[ext] || 'application/octet-stream';
  const commentEntry = asMarkup
    ? { type: 'markup', uuid: commentUuid, reporter: reporterEmail, markup: [] }
    : { type: 'file', uuid: commentUuid, reporter: reporterEmail };

  const form = new FormData();
  form.append('projectUuid', projectUuid);
  form.append('issueUuid', issue.uuid);
  form.append('comments', JSON.stringify([commentEntry]));
  form.append(`file_${commentUuid}`, fileBuffer, { filename: fileName, contentType: mime });

  console.log(`[revizto] addAttachment: ${JSON.stringify(commentEntry)}, file "${fileName}" (${mime}), ${fileBuffer.length} bytes`);

  const token = await getValidReviztoToken(userId);
  const { data } = await axios.post(`${baseUrl(region)}/comment/add`, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
  });
  const commentResult = data?.data?.[0]?.result;
  if (commentResult !== undefined && commentResult !== 0) {
    console.warn('[revizto] attachment/markup upload failed:', JSON.stringify(data));
  }
  return data;
}

/**
 * GET /v5/project/list/{licenseUuid}/paged — the real, documented endpoint.
 * (Earlier version of this code called a `/project/list?licenseId=` shape
 * copied from the old app, which turned out not to match current docs —
 * this replaces it.)
 * NOTE: ProjectListItem field names (what's actually inside data.data[])
 * are still unconfirmed — ask for that section of the docs before trusting
 * the mapping in routes/index.js.
 */
/**
 * GET /v5/license/{licenseUuid}/team — full license member list, each
 * with a nested `user` object including email/fullname/firstname/lastname.
 * Used to resolve an issue's assignee (a bare email) into a display name.
 */
async function getLicenseMembers(userId, region, licenseUuid, withDeactivated = false) {
  const response = await request(userId, region, 'GET', `/license/${licenseUuid}/team`, {
    params: withDeactivated ? { withDeactivated: true } : {},
  });
  return response.data?.entities || [];
}

/**
 * Builds { [email]: fullname } from getLicenseMembers' output.
 */
function buildMemberNameLookup(members) {
  const byEmail = {};
  for (const m of members) {
    if (m.user?.email && m.user?.fullname) byEmail[m.user.email.toLowerCase()] = m.user.fullname;
  }
  return byEmail;
}

/**
 * Builds { [email]: company } from getLicenseMembers' output. `company` is
 * a top-level field on the member entity itself (a sibling of `user`, NOT
 * nested under it) — confirmed from real Revizto docs.
 */
function buildMemberCompanyLookup(members) {
  const byEmail = {};
  for (const m of members) {
    if (m.user?.email && m.company) byEmail[m.user.email.toLowerCase()] = m.company;
  }
  return byEmail;
}

/**
 * GET /v5/issue/{issueUuid}/comments/date — comments added on/after
 * `date`. Oddly wants the project's NUMERIC id (not the UUID used
 * everywhere else) as a separate param. Returns mixed comment types
 * (text/file/diff/markup); sorted oldest-first per docs.
 */
async function getIssueComments(userId, region, issueUuid, projectId, date = '2000-01-01', page = 0) {
  const all = [];
  let currentPage = page;
  let totalPages = 1;
  while (currentPage < totalPages) {
    const response = await request(userId, region, 'GET', `/issue/${issueUuid}/comments/date`, {
      params: { date, projectId, page: currentPage },
    });
    const items = response.data?.data || [];
    all.push(...items);
    totalPages = response.data?.pages || 1;
    currentPage++;
  }
  return all;
}

/**
 * Returns the single most recent TEXT comment on an issue, or null if
 * there isn't one (e.g. only diff/file/markup comments exist, or no
 * comments at all). Non-text comments are skipped rather than pushed as
 * garbled text to ACC.
 */
/**
 * Returns the single most recent MARKUP UPDATE comment on an issue, or
 * null if there isn't one. Confirmed from real docs: this comment type's
 * `preview` field is a DIFFERENT image than the issue's own top-level
 * `preview` — this one "includes all drawings that were added to it,"
 * while the issue-level preview is just the base viewpoint with no
 * annotations. This is the one we actually want for markup sync.
 */
function findLatestMarkupComment(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].type === 'markup') return comments[i];
  }
  return null;
}

function findLatestTextComment(comments) {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].type === 'text') return comments[i];
  }
  return null;
}

async function getProjects(userId, region, licenseUuid, { page = 0, limit = 100, type = 'default' } = {}) {
  const allProjects = [];
  let currentPage = page;
  let totalPages = 1;
  while (currentPage < totalPages) {
    const response = await request(userId, region, 'GET', `/project/list/${licenseUuid}/paged`, {
      params: { page: currentPage, limit, type, sorting: 'name+' },
    });
    const items = response.data?.data || [];
    allProjects.push(...items);
    totalPages = response.data?.pages || 1;
    currentPage++;
  }
  return allProjects;
}

/**
 * GET /v5/user/licenses — lists licenses available to the current user.
 * NOTE: the docs define `id` here as an integer (e.g. 12345), but the old
 * app's working .env had REVIZTO_LICENSE_ID as a string like "USA-38628" —
 * those don't obviously match. We don't have confirmed docs for what
 * /project/list's `licenseId` param itself expects, only this endpoint's
 * shape. If project browsing fails after picking a license here, that
 * mismatch is the first thing to check.
 */
async function getLicenses(userId, region, accountUuid) {
  return request(userId, region, 'GET', '/user/licenses', {
    params: accountUuid ? { accountUuid } : {},
  });
}

/**
 * GET /v5/project/{projectUuid}/issue-preset/list — stamp templates and
 * their categories for a project. A "category" is an entity with
 * nodeRole=2; a "template" (individual stamp) has nodeRole=1 and points
 * to its category via parentUuid. Each template's `fields` is a
 * JSON-encoded STRING (not a nested object) containing stampAbbr,
 * customType, etc. — confirmed from Revizto's docs example response.
 */
async function getStampPresets(userId, region, projectUuid) {
  const all = [];
  let page = 0;
  let keepGoing = true;
  while (keepGoing) {
    const response = await request(userId, region, 'GET', `/project/${projectUuid}/issue-preset/list`, {
      params: { page },
    });
    const entities = response.data?.entities || [];
    all.push(...entities);
    keepGoing = entities.length === 200; // page size per docs; short page = last page
    page++;
  }
  return all;
}

/**
 * Builds a { [stampAbbr]: categoryTitle } lookup from getStampPresets'
 * output, so an issue's `stamp` field (the abbreviation) can be resolved
 * to a human-readable category name. Stamp category is NOT a direct field
 * on an issue — this indirection is why.
 */
function buildStampCategoryLookup(presetEntities) {
  const categoriesByUuid = {};
  for (const e of presetEntities) {
    if (e.nodeRole === 2) categoriesByUuid[e.uuid] = e.title;
  }
  const byAbbr = {};
  for (const e of presetEntities) {
    if (e.nodeRole !== 1) continue;
    let fields = {};
    try {
      fields = typeof e.fields === 'string' ? JSON.parse(e.fields) : e.fields || {};
    } catch {
      continue;
    }
    if (fields.stampAbbr && e.parentUuid && categoriesByUuid[e.parentUuid]) {
      byAbbr[fields.stampAbbr] = categoriesByUuid[e.parentUuid];
    }
  }
  return { byAbbr, categories: Object.values(categoriesByUuid) };
}

/**
 * Builds { [stampAbbr]: templateTitle } — for showing the human-readable
 * stamp title in the Issues page filter instead of the raw abbreviation.
 */
function buildStampTitleLookup(presetEntities) {
  const byAbbr = {};
  for (const e of presetEntities) {
    if (e.nodeRole !== 1) continue;
    let fields = {};
    try {
      fields = typeof e.fields === 'string' ? JSON.parse(e.fields) : e.fields || {};
    } catch {
      continue;
    }
    if (fields.stampAbbr && e.title) byAbbr[fields.stampAbbr] = e.title;
  }
  return byAbbr;
}

/**
 * Builds [{ value: stampAbbr, label: "Category > Stamp Title" }] for the
 * type-mapping dropdown — one entry per stamp template (nodeRole=1),
 * value is the abbreviation (what's matched against an issue's stampAbbr
 * at push time), label shows category + template title for readability.
 * Templates without a stampAbbr or an unresolvable parent category are
 * skipped (can't be reliably matched or labeled).
 */
function buildStampOptions(presetEntities) {
  const categoriesByUuid = {};
  for (const e of presetEntities) {
    if (e.nodeRole === 2) categoriesByUuid[e.uuid] = e.title;
  }
  const options = [];
  for (const e of presetEntities) {
    if (e.nodeRole !== 1) continue;
    let fields = {};
    try {
      fields = typeof e.fields === 'string' ? JSON.parse(e.fields) : e.fields || {};
    } catch {
      continue;
    }
    const categoryTitle = e.parentUuid ? categoriesByUuid[e.parentUuid] : null;
    if (fields.stampAbbr && categoryTitle && e.title) {
      options.push({ value: fields.stampAbbr, label: `${categoryTitle} > ${e.title}` });
    }
  }
  return options;
}

// ─── Field mapping (Revizto -> ACC) ─────────────────────────────────

function unwrap(field) {
  if (field === null || field === undefined) return null;
  if (typeof field === 'object' && 'value' in field) return field.value;
  return field;
}

function formatDateForAcc(dateStr) {
  const d = unwrap(dateStr);
  if (!d) return null;
  if (d === '2000-01-01 00:00:00' || d === '1970-01-01 00:00:00') return null;
  try {
    return new Date(d).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

const STAMP_SUBTYPE_MAP = [
  { contains: 'building code', label: 'Design > Building Code' },
  { contains: 'commissioning', label: 'Commissioning > Commissioning' },
  { contains: 'coordination', label: 'Coordination > Coordination' },
  { contains: 'clash', label: 'Coordination > Clash' },
  { contains: 'design', label: 'Design > Design' },
  { contains: 'observation', label: 'Observation > Observation' },
  { contains: 'punch', label: 'Punch List > Punch List' },
  { contains: 'quality', label: 'Quality > Quality' },
  { contains: 'safety', label: 'Safety > Safety' },
];

/**
 * Looks up an ACC subtype ID from the project's subtype list based on
 * keyword-matching the issue title. `subtypeLookup` is a map of
 * label -> id, fetched live from ACC (accService.getIssueSubtypes) rather
 * than hardcoded, since subtype IDs differ per ACC project/template.
 */
function getSubtypeIdForIssue(title, subtypeLookup, defaultSubtypeId) {
  const lower = (title || '').toLowerCase();
  for (const mapping of STAMP_SUBTYPE_MAP) {
    if (lower.includes(mapping.contains) && subtypeLookup[mapping.label]) {
      return subtypeLookup[mapping.label];
    }
  }
  return defaultSubtypeId;
}

/**
 * Last-resort subtype fallback, so an issue can never fail to sync purely
 * because nothing resolved a subtype (ACC rejects create/update with a
 * 400 if issueSubtypeId is missing — confirmed by real testing). First
 * tries to auto-detect a subtype actually named "General" (subtypeLookup
 * keys are "IssueType > Subtype" labels, e.g. "Design > General") since
 * that's explicitly what should back this safeguard when nothing else is
 * configured; failing that, picks whatever subtype happens to be first,
 * since ANY valid subtype beats a hard sync failure.
 */
function _findFallbackSubtypeId(subtypeLookup) {
  const entries = Object.entries(subtypeLookup);
  const general = entries.find(([label]) => label.toLowerCase().includes('general'));
  if (general) return general[1];
  return entries[0]?.[1] || null;
}

function mapStatusFromAcc(accStatus) {
  const map = {
    open: 'Open',
    in_progress: 'In progress',
    completed: 'Solved',
    closed: 'Closed',
    draft: 'Open',
    pending: 'Open',
    in_review: 'In progress',
    not_approved: 'In progress',
    in_dispute: 'In progress',
  };
  return map[accStatus] || 'Open';
}

/**
 * Converts a raw string value into whatever ACC's customAttributes API
 * expects for that field's data type: passed through as-is for
 * text/paragraph/numeric fields, but resolved to the matching dropdown
 * option's ID (not its display label) for list-type fields — confirmed
 * from Autodesk's own custom-attributes docs that list values must be the
 * option's ID. No matching option (a Revizto value with no equivalent in
 * ACC's dropdown) just skips that attribute rather than sending a bad
 * value ACC would reject outright.
 */
function _resolveCustomAttributeValue(definition, rawValue) {
  if (definition.dataType !== 'list') return String(rawValue);
  const options = definition.metadata?.list?.options || [];
  const match = options.find((o) => String(o.value ?? o.label ?? '').toLowerCase() === String(rawValue).toLowerCase());
  return match ? match.id : null;
}

function _addCustomAttribute(list, definition, rawValue) {
  if (!definition || rawValue == null || rawValue === '') return;
  const value = _resolveCustomAttributeValue(definition, rawValue);
  if (value == null) {
    console.warn(`[revizto] No matching ACC dropdown option on "${definition.title}" for Revizto value "${rawValue}"`);
    return;
  }
  console.log(`[revizto] Setting ACC custom field "${definition.title}" from Revizto value "${rawValue}"${definition.dataType === 'list' ? ` -> option id ${value}` : ''}`);
  list.push({ attributeDefinitionId: definition.id, value });
}

/**
 * Build an ACC issue payload from a Revizto issue. Returns
 * { payload, statusNeedsMapping, typeNeedsMapping } — true when the
 * issue's status/stamp has no admin mapping configured and had to fall
 * back to a safeguard default (Draft / the project's default subtype); the
 * caller uses these to record a visible sync error rather than silently
 * accepting the safeguard.
 * assigneeResolver: async (email) => autodeskId | null
 */
async function toAccIssue(reviztoIssue, { subtypeLookup = {}, defaultSubtypeId, assigneeResolver, locationResolver, customAttributeResolver, reviztoStatusFieldResolver, customStatusMap = null, customTypeMap = null, reviztoStatusName = null, autoMappedStatuses = null, workflowUuid = null, workflowLabel = null } = {}) {
  const title = unwrap(reviztoIssue.title) || '(no title)';
  // Revizto issues have no description field of their own — this is a
  // fixed marker instead, so users can filter/identify synced issues in
  // ACC by description.
  const description = 'Synced from Revizto';
  const dueDate = formatDateForAcc(reviztoIssue.deadline);
  // ACC's own native "Created On" can't be targeted — confirmed against
  // Autodesk's create-issue request schema, it's server-assigned to
  // whenever the POST happens (i.e. sync time), not settable. So the only
  // way to show Revizto's real creation date in ACC is this managed custom
  // field ("Date Created", already provisioned on this project) instead of
  // the built-in column — see customAttributes below, Revizto -> ACC only,
  // since Revizto's own `created` is authoritative and never changes.
  const createdDate = formatDateForAcc(reviztoIssue.created);

  // Same reasoning, same fix, for who created it: ACC's native "Created
  // By" is also server-assigned — confirmed by testing, it comes back set
  // to whichever ACC account this app's own connection used to make the
  // POST (the project's owner user), never something the request body can
  // set — so it can't reflect the real Revizto author either. `author` is
  // the richer, unwrapped top-level object (firstname/lastname/email,
  // confirmed present on real issue data — same shape as a comment's
  // `author`); `reporter` (bare, {value}-wrapped email) is only a
  // fallback for the rare case `author` isn't populated.
  const reporterName = reviztoIssue.author?.firstname || reviztoIssue.author?.lastname
    ? [reviztoIssue.author.firstname, reviztoIssue.author.lastname].filter(Boolean).join(' ')
    : unwrap(reviztoIssue.reporter);

  // Confirmed from real Revizto docs: clashAndLocationFields.level/.zone
  // are both array[string] — normally one entry, more than one only for a
  // clash issue spanning multiple levels/zones. ACC's locationId is a
  // single value (a reference into the project's own Location Breakdown
  // Structure tree), not an array, so only the first level is used when
  // an issue spans several. Only populated on the response if the request
  // explicitly asks for it via additionalFields (see getIssues/getIssue).

  const levels = reviztoIssue.clashAndLocationFields?.level || [];
  const primaryLevel = levels[0] || null;
  const zones = reviztoIssue.clashAndLocationFields?.zone || [];
  const grids = reviztoIssue.clashAndLocationFields?.grid || [];
  const rooms = reviztoIssue.clashAndLocationFields?.room || [];
  const tagsList = unwrap(reviztoIssue.tags) || [];
  // Top-level field (not under clashAndLocationFields), same
  // {value, timestamp}-wrapped shape as assignee/deadline/etc. — no extra
  // additionalFields param needed, same as those.
  const priority = unwrap(reviztoIssue.priority) || null;

  // Status comes from `customStatus` (a UUID resolved against the
  // project's workflow settings) — NOT `status`, which Revizto's own docs
  // mark deprecated and doesn't reliably exist on real responses.
  //
  // Name-based auto-routing (reverted from an earlier category-based
  // design, explicit request): the 4 canonical Revizto status names
  // (Open/In progress/Solved/Closed — same 4 the ACC->Revizto direction
  // auto-maps) always map to a fixed ACC status with no admin config
  // needed, in ANY workflow. Every other custom status needs an explicit
  // admin decision, since ACC has several statuses that could reasonably
  // apply (in_progress, in_review, etc.) — and since two different
  // workflows can define a same-named custom status that should map
  // differently, customStatusMap is keyed by workflow first:
  // { [workflowUuid]: { [statusName]: {accStatus, accCustomStatusOptionId} } },
  // with a '' bucket for mappings saved before workflow scoping existed
  // (see fieldMapping.getStatusMap). If not configured, default to
  // "draft" (a safeguard, not a real answer — deliberately distinct from
  // any real status so an unmapped issue can't be mistaken for one that's
  // genuinely open/in-progress) and flag it via statusNeedsMapping rather
  // than silently guessing.
  let status;
  let statusNeedsMapping = false;
  let secondaryStatusOptionId = null;
  const autoMapped = autoMappedStatuses && autoMappedStatuses[reviztoStatusName];
  if (autoMapped) {
    status = autoMapped;
  } else {
    const configured =
      customStatusMap?.[workflowUuid]?.[reviztoStatusName] ?? customStatusMap?.['']?.[reviztoStatusName] ?? null;
    if (configured) {
      status = configured.accStatus;
      secondaryStatusOptionId = configured.accCustomStatusOptionId || null;
    } else {
      status = 'draft';
      statusNeedsMapping = true;
    }
  }

  // Admin-configured type mapping is now keyed by stamp abbreviation (the
  // Setup page dropdown shows "Category > Stamp Title" but stores the
  // abbreviation, since that's what's actually on an issue). Falls back,
  // in order: the project's configured default subtype, a title-keyword
  // guess, an auto-detected "General" subtype, then literally any
  // available subtype — all safeguards, not a real answer (flagged via
  // typeNeedsMapping), but guaranteed to resolve to SOMETHING so the push
  // can never fail with a 400 purely from a missing issueSubtypeId.
  const rawType = unwrap(reviztoIssue.stampAbbr) ?? unwrap(reviztoIssue.customTypeName) ?? null;
  const typeConfigured = customTypeMap && rawType && customTypeMap[rawType];
  const typeNeedsMapping = !typeConfigured;
  const subtypeId =
    typeConfigured ||
    defaultSubtypeId ||
    getSubtypeIdForIssue(title, subtypeLookup, null) ||
    _findFallbackSubtypeId(subtypeLookup);

  const payload = { title: String(title), description: String(description), status, issueSubtypeId: subtypeId };
  // ACC's API likely wants dueDate either a real date string or omitted
  // entirely — sending an explicit `null` for a string field is a
  // plausible cause of the "must be string" validation error seen on
  // issues without a due date set.
  if (dueDate) payload.dueDate = dueDate;

  // locationResolver: async (levelName) => ACC location node ID | null —
  // resolves by matching the level's name against the project's own
  // Location Breakdown Structure (fetched by the caller, since that needs
  // project/token context this function doesn't have). No match (no
  // Locations tree configured, or no node with this name) just leaves
  // locationId unset — locationDetails is reserved for zone, below, not
  // used as a level fallback.
  if (primaryLevel && locationResolver) {
    const locationId = await locationResolver(primaryLevel);
    if (locationId) payload.locationId = locationId;
  }

  // Zone -> ACC's locationDetails (free text) — kept separate from the
  // level/locationId mapping above by design, so this field is reserved
  // for zone specifically rather than doubling as a level fallback.
  if (zones.length) payload.locationDetails = zones.join(', ');

  // Grid, room, tags, the issue's own ID, creation date, reporter, &
  // priority -> ACC custom fields ("Grid Intersection", "Room", "Tags",
  // "Revizto ID", "Date Created", "Reporter", "Issue Priority") — ACC has
  // no native fields for these (or, for Date Created/Reporter, no
  // *settable* native field — see above), unlike level/zone, so
  // customAttributeResolver looks up the admin-created custom field by
  // title instead of a built-in column, and also checks it's actually
  // mapped to this issue's subtype (subtypeId, computed above) — a field
  // can exist in the project but not apply to every issue subtype. No
  // match (field doesn't exist, wrong title, not mapped to this subtype,
  // etc.) just skips that one attribute rather than failing the push.
  // Revizto ID is written on every push (not conditional like the others)
  // since it's always available and useful for traceability back to the
  // source issue.
  const customAttributes = [];
  if (customAttributeResolver) {
    if (grids.length) _addCustomAttribute(customAttributes, await customAttributeResolver('Grid Intersection', subtypeId), grids.join(', '));
    if (rooms.length) _addCustomAttribute(customAttributes, await customAttributeResolver('Room', subtypeId), rooms.join(', '));
    if (tagsList.length) _addCustomAttribute(customAttributes, await customAttributeResolver('Tags', subtypeId), tagsList.join(', '));
    if (reviztoIssue.id != null) _addCustomAttribute(customAttributes, await customAttributeResolver('Revizto ID', subtypeId), String(reviztoIssue.id));
    // Same "written on every push" treatment as Revizto ID, for the same
    // reason: always available, and re-sending it is a harmless no-op
    // since Revizto's `created` never changes after the issue exists.
    if (createdDate) _addCustomAttribute(customAttributes, await customAttributeResolver('Date Created', subtypeId), createdDate);
    // Same reasoning/treatment as Date Created just above — an issue's
    // author doesn't change after creation either.
    if (reporterName) _addCustomAttribute(customAttributes, await customAttributeResolver('Reporter', subtypeId), reporterName);
    // Issue Priority is a dropdown/list field in ACC, not free text (unlike
    // the others above) — _addCustomAttribute resolves the raw Revizto
    // priority string to the matching dropdown option's ID.
    if (priority) _addCustomAttribute(customAttributes, await customAttributeResolver('Issue Priority', subtypeId), priority);
  }

  // Revizto Status: the secondary, precise status target (see status
  // resolution above). A project can have several of these ACC fields,
  // one per workflow (e.g. "Revizto Status - Pre Pour Checklist"), so
  // this uses its own resolver (workflow-aware) instead of
  // customAttributeResolver's single-fixed-title lookup — see
  // syncService.makeReviztoStatusFieldResolver. An explicit admin-
  // configured option ID (already known, from Setup) wins outright —
  // pushed directly rather than through _addCustomAttribute's name-
  // matching, since it's already the exact option, not a raw Revizto
  // string. Otherwise, auto-map by exact name: same zero-config
  // philosophy as the 4 canonical statuses, extended to any custom status
  // whose name already matches an ACC "Revizto Status" option exactly.
  if (reviztoStatusFieldResolver && (reviztoStatusName || secondaryStatusOptionId)) {
    const statusFieldDef = await reviztoStatusFieldResolver(workflowLabel, subtypeId);
    if (statusFieldDef) {
      let optionId = secondaryStatusOptionId;
      if (!optionId) {
        const fieldOptions = statusFieldDef.metadata?.list?.options || [];
        const nameMatch = fieldOptions.find(
          (o) => String(o.value ?? o.label ?? '').trim().toLowerCase() === String(reviztoStatusName).trim().toLowerCase()
        );
        optionId = nameMatch?.id || null;
      }
      if (optionId) customAttributes.push({ attributeDefinitionId: statusFieldDef.id, value: optionId });
    } else if (secondaryStatusOptionId) {
      console.warn('[revizto] No matching "Revizto Status" custom field found/mapped in ACC for this issue\'s workflow/subtype — skipping secondary status sync.');
    }
  }
  if (customAttributes.length) payload.customAttributes = customAttributes;

  // assigneeResolver is really a generic (email) -> Autodesk user ID
  // resolver — reused here for both assignee (single) and watchers
  // (array), not just assignee despite the parameter name.
  const assigneeEmail = unwrap(reviztoIssue.assignee);
  if (assigneeEmail && assigneeResolver) {
    const assignedTo = await assigneeResolver(assigneeEmail);
    if (assignedTo) {
      payload.assignedTo = assignedTo;
      payload.assignedToType = 'user';
    }
  }

  // Confirmed from real data: Revizto's `watchers` field is an array of
  // emails. Confirmed from ACC's own create-issues docs example: ACC's
  // `watchers` field is an array of Autodesk user IDs — same ID format
  // as assignedTo, so the same resolver applies per-email.
  const watcherEmails = unwrap(reviztoIssue.watchers) || [];
  if (watcherEmails.length && assigneeResolver) {
    const resolvedWatchers = [];
    for (const email of watcherEmails) {
      const autodeskId = await assigneeResolver(email);
      if (autodeskId) resolvedWatchers.push(autodeskId);
    }
    if (resolvedWatchers.length) payload.watchers = resolvedWatchers;
  }

  return { payload, statusNeedsMapping, typeNeedsMapping };
}

module.exports = {
  getIssues,
  getIssue,
  updateIssueStatus,
  updateIssueAssignee,
  updateIssueWatchers,
  updateIssuePriority,
  updateIssueDeadline,
  updateIssueTitle,
  getWorkflowSettings,
  resolveIssueWorkflowUuid,
  getWorkflowLabel,
  getWorkflowStatusNames,
  addComment,
  addAttachment,
  getProjects,
  getLicenses,
  getLicenseMembers,
  buildMemberNameLookup,
  buildMemberCompanyLookup,
  getStatusMap,
  getStampPresets,
  buildStampCategoryLookup,
  buildStampTitleLookup,
  buildStampOptions,
  getIssueComments,
  findLatestTextComment,
  findLatestMarkupComment,
  toAccIssue,
  mapStatusFromAcc,
  unwrap,
};
