const express = require('express');
const router = express.Router();
const path = require('path');
const pool = require('../db/pool');
const { requireLogin, requireAdmin } = require('./auth');
const syncService = require('../services/syncService');
const accService = require('../services/accService');
const reviztoService = require('../services/reviztoService');
const tokenStore = require('../services/tokenStore');
const fieldMapping = require('../services/fieldMapping');
const { ReconnectRequiredError } = require('../services/authManager');

// ─── Revizto license browser (for the license dropdown) ─────────────

router.get('/api/revizto/licenses', requireLogin, async (req, res) => {
  const tokens = await tokenStore.getReviztoTokens(req.session.userId);
  if (!tokens) return res.status(409).json({ error: 'Connect Revizto first' });
  try {
    const response = await reviztoService.getLicenses(req.session.userId, tokens.region);
    const licenses = (response.data?.entities || []).map((l) => ({
      id: l.id,
      uuid: l.uuid,
      name: l.name,
      region: l.region,
      frozen: l.frozen,
    }));
    res.json({ licenses });
  } catch (err) {
    console.error('[revizto] getLicenses failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.get('/api/revizto/projects', requireLogin, async (req, res) => {
  const tokens = await tokenStore.getReviztoTokens(req.session.userId);
  if (!tokens) return res.status(409).json({ error: 'Connect Revizto first' });
  if (!tokens.license_id) {
    return res.status(409).json({ error: 'missing_license_id', message: 'Select your Revizto license first' });
  }
  try {
    // tokens.license_id now holds the license UUID (not the numeric id) —
    // see reviztoService.getProjects for why.
    const items = await reviztoService.getProjects(req.session.userId, tokens.region, tokens.license_id);
    // id/uuid/title confirmed from real ProjectListItem docs.
    const projects = items.map((p) => ({ id: p.id, uuid: p.uuid, title: p.title || p.name }));
    res.json({ projects });
  } catch (err) {
    console.error('[revizto] getProjects failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ─── ACC hub/project browser (for the "add project" dropdowns) ──────

router.get('/api/acc/hubs', requireLogin, async (req, res) => {
  try {
    const hubs = await accService.getHubs(req.session.userId);
    res.json({ hubs });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[acc] getHubs failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.developerMessage || err.message });
  }
});

router.get('/api/acc/hubs/:hubId/projects', requireLogin, async (req, res) => {
  try {
    const projects = await accService.getHubProjects(req.session.userId, req.params.hubId);
    res.json({ projects });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[acc] getHubProjects failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.developerMessage || err.message });
  }
});

router.get('/', (req, res) => {
  res.redirect('/issues');
});

router.get('/account', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/account.html'));
});

router.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/setup.html'));
});

router.get('/team', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/team.html'));
});

router.get('/issues', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/issues.html'));
});

// ─── Projects (Revizto project <-> ACC project pairing) ────────────

router.get('/api/projects', requireLogin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
  res.json({ projects: rows });
});

router.post('/api/projects', requireAdmin, async (req, res) => {
  const {
    name,
    revizto_project_uuid,
    revizto_project_id,
    revizto_region,
    acc_hub_id,
    acc_project_id,
    acc_default_subtype_id,
    makeMeOwner,
  } = req.body;
  if (!name || !revizto_project_uuid || !acc_hub_id || !acc_project_id) {
    return res.status(400).json({ error: 'name, revizto_project_uuid, acc_hub_id, acc_project_id are required' });
  }
  const { rows } = await pool.query(
    `INSERT INTO projects (name, revizto_project_uuid, revizto_project_id, revizto_region, acc_hub_id, acc_project_id, acc_default_subtype_id, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      name,
      revizto_project_uuid,
      revizto_project_id || null,
      revizto_region || 'virginia',
      acc_hub_id,
      acc_project_id,
      acc_default_subtype_id || null,
      makeMeOwner ? req.session.userId : null,
    ]
  );
  res.json({ project: rows[0] });
});

router.get('/api/projects/:id/issues-board', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const board = await syncService.getIssuesBoard(req.session.userId, project);
    res.json({ board });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[issues-board] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/projects/:id/linked-issues', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const pairs = await syncService.getLinkedIssuePairs(req.session.userId, project);
    res.json({ pairs });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    res.status(500).json({ error: err.message });
  }
});

// Finds an existing hook for this project (registered previously but
// whose ID never got saved locally — root cause: the ID field name in
// the create-response wasn't what the code assumed) and repairs the DB.
// Also logs the raw response so we can confirm the real field name for
// good, instead of continuing to guess.
router.post('/api/projects/:id/relink-webhook', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const hooks = await accService.listWebhooks(req.session.userId);
    console.log('[relink-webhook] raw hooks list:', JSON.stringify(hooks, null, 2));
    const containerId = project.acc_project_id.replace(/^b\./, '');
    const match = hooks.find((h) => h.scope?.project === containerId);
    if (!match) return res.status(404).json({ error: 'No existing hook found on ACC for this project — try registering instead.' });
    const hookId = match.hookId || match.id;
    if (!hookId) return res.status(500).json({ error: 'Found a matching hook but could not determine its ID field — check server logs for the raw response.' });
    await pool.query('UPDATE projects SET webhook_id = $2 WHERE id = $1', [project.id, hookId]);
    res.json({ ok: true, hookId, raw: match });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[relink-webhook] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

// Raw, unfiltered dump of every hook for this event system the token can
// see — bypasses our own project-matching logic entirely, for cases where
// that logic might be missing something (e.g. a subtle scope format
// mismatch) rather than trusting our own filter.
router.get('/api/debug/list-all-webhooks', requireAdmin, async (req, res) => {
  try {
    const hooks = await accService.listWebhooks(req.session.userId);
    res.json({ count: hooks.length, hooks });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

router.get('/api/projects/:id/webhook-status', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.webhook_id) return res.status(404).json({ error: 'No webhook registered for this project yet' });
  try {
    const hook = await accService.getWebhookStatus(req.session.userId, project.webhook_id);
    res.json({ hook });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[webhook-status] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

// Diagnostic: register a webhook pointing at an arbitrary URL (e.g. a
// webhook.site test URL), to isolate whether ACC's delivery reaches ANY
// server, independent of our own app/hosting. Doesn't touch project.webhook_id.
router.post('/api/projects/:id/register-test-webhook', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const { callbackUrl } = req.body;
  if (!callbackUrl) return res.status(400).json({ error: 'callbackUrl required' });
  try {
    const hook = await accService.registerTestWebhook(req.session.userId, project, callbackUrl);
    res.json({ ok: true, hookId: hook.hookId || hook.id, hook });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[register-test-webhook] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

router.delete('/api/projects/:id/webhook/:hookId', requireAdmin, async (req, res) => {
  try {
    await accService.deleteWebhook(req.session.userId, req.params.hookId);
    await pool.query('UPDATE projects SET webhook_id = NULL WHERE id = $1 AND webhook_id = $2', [req.params.id, req.params.hookId]);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[delete-webhook] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

// Actually tells ACC to start calling our /webhook/acc endpoint. Requires
// PUBLIC_BASE_URL to be a real internet-reachable HTTPS URL — this will
// fail (as it should) if run against localhost, since ACC's servers can't
// reach your laptop.
router.post('/api/projects/:id/register-webhook', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL.includes('localhost')) {
    return res.status(400).json({ error: 'PUBLIC_BASE_URL must be set to your real deployed URL — webhooks cannot reach localhost.' });
  }
  try {
    // Using /webhook/acc-v2, not /webhook/acc — real testing showed ACC's
    // delivery system silently suppresses delivery to /webhook/acc (an
    // identical hook pointing at a brand-new path worked immediately),
    // most likely due to accumulated delivery-failure history against
    // that specific URL from earlier in this project's testing. The old
    // path is kept alive (still handled by the same code) in case it
    // recovers on its own over time, but new registrations use v2.
    const callbackUrl = `${process.env.PUBLIC_BASE_URL}/webhook/acc-v2`;
    const hook = await accService.registerWebhook(req.session.userId, project, callbackUrl);
    await pool.query('UPDATE projects SET webhook_id = $2 WHERE id = $1', [project.id, hook.hookId || hook.id || null]);
    res.json({ ok: true, hook });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[webhook] registration failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.detail || err.message });
  }
});

// Open to any signed-in user — shows on the Issues page for everyone, and
// later the Analytics page. Not admin-gated, unlike mapping-warnings below.
router.get('/api/projects/:id/stats', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const stats = await syncService.getSyncStats(req.session.userId, project);
    res.json(stats);
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[stats] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin-only — this is a "go fix your mapping" action item, not a general stat.
router.get('/api/projects/:id/mapping-warnings', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const warnings = await fieldMapping.getUnmappedFields(req.session.userId, project);
    res.json(warnings);
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── Field mapping (status & issue type) — admin only ───────────────

router.get('/api/projects/:id/mapping-options', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const options = await fieldMapping.getMappingOptions(req.session.userId, project);
    res.json(options);
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/projects/:id/status-map', requireAdmin, async (req, res) => {
  const map = await fieldMapping.getStatusMap(req.params.id);
  res.json({ map });
});

router.post('/api/projects/:id/status-map', requireAdmin, async (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' });
  await fieldMapping.saveStatusMap(req.params.id, mappings);
  res.json({ ok: true });
});

router.get('/api/projects/:id/type-map', requireAdmin, async (req, res) => {
  const map = await fieldMapping.getTypeMap(req.params.id);
  res.json({ map });
});

router.post('/api/projects/:id/type-map', requireAdmin, async (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'mappings array required' });
  await fieldMapping.saveTypeMap(req.params.id, mappings);
  res.json({ ok: true });
});

// Auto-sync-by-filter (Setup page) — opt-in per project, off by default.
// Filter option VALUES reuse the existing /issues-board endpoint (same
// data the Issues page's own filters already draw from), so there's no
// separate options endpoint here.
router.get('/api/projects/:id/auto-sync-filters', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const filters = await fieldMapping.getAutoSyncFilters(req.params.id);
  res.json({ enabled: project.auto_sync_enabled, filters });
});

router.post('/api/projects/:id/auto-sync-filters', requireAdmin, async (req, res) => {
  const { enabled, filters } = req.body;
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    return res.status(400).json({ error: 'filters object required' });
  }
  await pool.query('UPDATE projects SET auto_sync_enabled = $2 WHERE id = $1', [req.params.id, !!enabled]);
  await fieldMapping.saveAutoSyncFilters(req.params.id, filters);
  res.json({ ok: true });
});

// Whether any signed-in user (not just admins) can manually unlink an
// issue from the Issues page — admin-only to toggle, off by default.
router.post('/api/projects/:id/allow-manual-unlink', requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  const { rows } = await pool.query('UPDATE projects SET allow_manual_unlink = $2 WHERE id = $1 RETURNING *', [
    req.params.id,
    !!enabled,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: rows[0] });
});

// Manual unlink (Issues page) — only removes this app's own sync_map
// bookkeeping row, never the actual issue in Revizto or ACC. Gated on the
// project's own allow_manual_unlink flag server-side too, not just by
// hiding the button client-side — so toggling it off actually revokes
// the capability rather than just hiding it from someone who already has
// the page open. requireLogin (not requireAdmin): once an admin has
// turned this on, any signed-in user can use it, per the feature's intent.
router.post('/api/projects/:id/issues/:reviztoIssueId/unlink', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.allow_manual_unlink) return res.status(403).json({ error: 'Manual unlinking is not enabled for this project' });
  await syncService.unlinkIssue(req.session.userId, project, req.params.reviztoIssueId, req.session.userEmail);
  res.json({ ok: true });
});

// ─── Sync (on-demand) ────────────────────────────────────────────────

router.get('/api/projects/:id/revizto-issues', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const issues = await reviztoService.getIssues(req.session.userId, project.revizto_region, project.revizto_project_uuid);
    const list = issues.map((i) => ({
      id: i.id,
      title: i.title?.value ?? i.title ?? '(no title)',
      status: i.status?.value ?? i.status ?? '',
    }));
    res.json({ issues: list });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[revizto] listing issues for selection failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/api/projects/:id/revizto-project-id', requireAdmin, async (req, res) => {
  const { revizto_project_id } = req.body;
  if (!revizto_project_id) return res.status(400).json({ error: 'revizto_project_id required' });
  const { rows } = await pool.query('UPDATE projects SET revizto_project_id = $2 WHERE id = $1 RETURNING *', [
    req.params.id,
    revizto_project_id,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: rows[0] });
});

// Was previously only settable via a raw text ID field on the "Add
// project pairing" form (easy to skip, since it was marked optional) —
// this is the ONLY thing that gives an unmapped-type issue somewhere real
// to land in ACC, so it needs to be viewable/editable for a project that
// already exists, not just at creation time.
router.patch('/api/projects/:id/default-subtype', requireAdmin, async (req, res) => {
  const { acc_default_subtype_id } = req.body;
  const { rows } = await pool.query('UPDATE projects SET acc_default_subtype_id = $2 WHERE id = $1 RETURNING *', [
    req.params.id,
    acc_default_subtype_id || null,
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: rows[0] });
});

router.post('/api/projects/:id/sync', requireLogin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { issueIds } = req.body;
  if (!Array.isArray(issueIds) || !issueIds.length) {
    return res.status(400).json({ error: 'issueIds required — select at least one issue to sync' });
  }

  try {
    const results = await syncService.pushSelectedIssues(req.session.userId, project, issueIds);
    res.json({ results });
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return res.status(409).json({ error: `Reconnect required: ${err.provider}`, reason: err.reason });
    }
    console.error('[sync] Failed:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/api/projects/:id/subtypes', requireAdmin, async (req, res) => {
  const project = await _getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  try {
    const subtypes = await accService.getIssueSubtypes(req.session.userId, project);
    res.json({ subtypes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook receiver (ACC -> app) ───────────────────────────────────
// NOTE: verifying the webhook signature against WEBHOOK_SECRET is left
// as a TODO — Autodesk's exact signature scheme should be confirmed
// against current APS webhook docs before going live, rather than assumed.

async function _handleAccWebhookRequest(req, res) {
  res.status(200).send('ok'); // ack immediately; ACC expects a fast response

  console.log(`[webhook] Received on ${req.path}`);

  // Confirmed from a real webhook delivery: scope is nested under
  // hook.scope.project, not top-level hookScope.project as originally
  // guessed.
  const { rows: projects } = await pool.query('SELECT * FROM projects');
  const project = projects.find((p) => req.body?.hook?.scope?.project === p.acc_project_id.replace(/^b\./, ''));
  if (!project || !project.owner_user_id) {
    console.warn('[webhook] No matching project/owner for payload:', req.body?.hook?.scope);
    return;
  }

  try {
    // req.session?.userEmail was always undefined here — a webhook POST
    // from ACC carries no session cookie, so this silently sent
    // `reporter: undefined` (dropped entirely by JSON.stringify) to
    // Revizto's comment API, which likely accepted the request but never
    // actually applied the status diff. Use the project owner's real
    // email instead, since their token is what's doing the work anyway.
    const { rows: ownerRows } = await pool.query('SELECT email FROM users WHERE id = $1', [project.owner_user_id]);
    const reporterEmail = ownerRows[0]?.email;
    await syncService.handleAccWebhook(project.owner_user_id, project, req.body.payload, reporterEmail);
  } catch (err) {
    console.error('[webhook] Processing failed:', err.message);
  }
}

router.post('/webhook/acc', express.json(), _handleAccWebhookRequest);

// TEMP DIAGNOSTIC: a brand-new, never-before-used path, to test whether
// Autodesk's delivery system is suppressing delivery specifically to
// /webhook/acc based on its past failure history (a common pattern in
// webhook systems generally — the hook resource can show "active" while
// delivery to a specific previously-failing URL is quietly suppressed).
// If this path works where /webhook/acc doesn't, that confirms it.
router.post('/webhook/acc-v2', express.json(), _handleAccWebhookRequest);

async function _getProject(id) {
  const { rows } = await pool.query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = router;
