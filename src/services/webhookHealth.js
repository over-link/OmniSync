/**
 * services/webhookHealth.js
 * Keeps every paired project's ACC webhook alive with nobody having to
 * think about it. Registering at pairing time (routes/index.js
 * _autoRegisterWebhook) isn't enough on its own: ACC can drop a hook
 * without notice — both live hooks were found deleted (404) on 2026-09-27,
 * cause unknown — after which edits made in ACC silently stopped reaching
 * Revizto. So an hourly check (pollService) asks ACC about each project's
 * hook and repairs it: re-registers a missing one, turns an inactive one
 * back on. Repairs and failures go to the Activity Log (action 'webhook')
 * so a broken hook is visible instead of silent.
 *
 * Every hook is registered with the project OWNER's token — the same
 * token deliveries are processed with — since ACC hooks belong to the user
 * who created them and another user's token can't even see them.
 */
const pool = require('../db/pool');
const licenseState = require('./licenseState');
const accService = require('./accService');
const auditLog = require('./auditLog');
const { ReconnectRequiredError } = require('./authManager');

// null when PUBLIC_BASE_URL isn't a real deployed URL (e.g. local dev) —
// ACC can't call a laptop, so there's nothing to register.
function callbackUrl() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base || base.includes('localhost')) return null;
  // /webhook/acc-v2, not /webhook/acc — real testing showed ACC's delivery
  // system silently suppressing delivery to /webhook/acc (an identical hook
  // on a brand-new path worked immediately), most likely from accumulated
  // delivery failures against that URL. The old path is still handled.
  return `${base}/webhook/acc-v2`;
}

/**
 * Registers the project's hook with its owner's token (adopting one that
 * already exists — accService.registerWebhook) and saves its id.
 */
async function registerForProject(project) {
  const url = callbackUrl();
  if (!url) throw new Error('PUBLIC_BASE_URL is not set to a real deployed URL.');
  if (!project.owner_user_id) throw new Error('The project has no owner to register the webhook for.');
  const { hookId, adopted } = await accService.registerWebhook(project.owner_user_id, project, url);
  await pool.query('UPDATE projects SET webhook_id = $2 WHERE id = $1', [project.id, hookId]);
  return { hookId, adopted };
}

// What each project's last check found wrong (in memory), so a problem
// that lasts for days gets one Activity Log row, not one every hour — and
// a "working again" row once it clears. A restart forgets it, which at
// worst repeats a still-open problem once.
const lastProblem = new Map();

async function _inspectAndRepair(project) {
  if (project.webhook_id) {
    let hook = null;
    try {
      hook = await accService.getWebhookStatus(project.owner_user_id, project.webhook_id);
    } catch (err) {
      if (err.response?.status !== 404) throw err; // 404: ACC no longer has it
    }
    if (hook?.status === 'active') return { ok: true };
    if (hook) {
      await accService.setWebhookStatus(project.owner_user_id, project.webhook_id, 'active');
      return { repaired: `ACC had switched this project's webhook off (status "${hook.status}") — turned it back on.` };
    }
  }
  const { hookId, adopted } = await registerForProject(project);
  if (adopted) return { repaired: `Found this project's webhook on ACC and reconnected it (${hookId}).` };
  return {
    repaired: project.webhook_id
      ? `ACC no longer had this project's webhook — registered a new one (${hookId}).`
      : `This project had no webhook — registered one (${hookId}).`,
  };
}

function _describeFailure(err) {
  if (err instanceof ReconnectRequiredError) {
    return `The project owner must reconnect ${err.provider === 'acc' ? 'ACC' : 'Revizto'} before its webhook can be checked or repaired — until then, changes made in ACC won't reach Revizto.`;
  }
  const status = err.response?.status;
  if (status === 403) {
    return "ACC refused to register this project's webhook (403) — the project owner must be an ACC project admin.";
  }
  const detail = err.response?.data?.detail || err.response?.data?.message || err.message;
  return `Couldn't check or repair this project's webhook${status ? ` (ACC ${status})` : ''}: ${Array.isArray(detail) ? detail.join('; ') : detail}`;
}

async function _record(project, outcome, detail) {
  await auditLog.record({ projectId: project.id, action: 'webhook', outcome, detail }).catch((err) =>
    console.error('[webhook-health] Could not write to the Activity Log:', err.message)
  );
}

/** Checks one project's hook, repairs it if needed, and logs what changed. */
async function checkProject(project) {
  let result;
  try {
    result = await _inspectAndRepair(project);
  } catch (err) {
    result = { problem: _describeFailure(err) };
    console.error(`[webhook-health] "${project.name}":`, err.response?.data || err.message);
  }

  if (result.problem) {
    if (lastProblem.get(project.id) !== result.problem) await _record(project, 'error', result.problem);
    lastProblem.set(project.id, result.problem);
  } else if (result.repaired) {
    console.log(`[webhook-health] "${project.name}": ${result.repaired}`);
    await _record(project, 'success', result.repaired);
    lastProblem.delete(project.id);
  } else if (lastProblem.has(project.id)) {
    await _record(project, 'success', "This project's webhook is working again.");
    lastProblem.delete(project.id);
  }
  return result;
}

/** The hourly sweep over every paired, active project with an owner. */
async function checkAllProjects() {
  if (!callbackUrl()) {
    console.log('[webhook-health] PUBLIC_BASE_URL is not a real deployed URL — skipping the webhook check.');
    return [];
  }
  const { rows: allProjects } = await pool.query(
    'SELECT * FROM projects WHERE owner_user_id IS NOT NULL AND revizto_project_uuid IS NOT NULL AND acc_project_id IS NOT NULL AND archived_at IS NULL ORDER BY id'
  );
  // Never repair or re-register the hooks of a license that isn't active — its
  // syncing is paused (services/licenseState.js).
  const syncing = await licenseState.syncingLicenseIds();
  const projects = allProjects.filter((p) => !p.tenant_license_id || syncing.has(p.tenant_license_id));
  const results = [];
  for (const project of projects) {
    results.push({ projectId: project.id, ...(await checkProject(project)) });
  }
  return results;
}

module.exports = { callbackUrl, registerForProject, checkProject, checkAllProjects };
