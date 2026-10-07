/**
 * services/issueReadCache.js
 * A short (30 s) shared cache of a project's full issue lists from Revizto and
 * ACC, for the two READ-ONLY views that load them together — the Issues
 * board and the sync stats. Without it, opening the Issues page reads both
 * full lists twice. NOT used by the sync paths (poll, webhook, push), which
 * always read fresh.
 *
 * Per person (what ACC shows depends on who is asking) and per pairing (a
 * re-paired project misses the cache). Callers asking at the same moment
 * share one request. Anything that changes a link (syncService.recordLink /
 * clearLink) calls invalidate(projectId), so a just-linked issue is never
 * judged against a stale list.
 */
const { createTtlCache } = require('./ttlCache');

const TTL_MS = 30 * 1000;
const cache = createTtlCache(TTL_MS);

const reviztoKey = (userId, project) => `rv:${project.id}:${userId}:${project.revizto_project_uuid}`;
const accKey = (userId, project) => `acc:${project.id}:${userId}:${project.acc_project_id}`;

/** load() runs only if there's no fresh copy (or one still being fetched). */
const reviztoIssues = (userId, project, load) => cache.get(reviztoKey(userId, project), load);
const accIssues = (userId, project, load) => cache.get(accKey(userId, project), load);

/** Forget everything cached for a project (all people). */
function invalidate(projectId) {
  cache.deleteWhere((key) => key.split(':')[1] === String(projectId));
}

module.exports = { TTL_MS, reviztoIssues, accIssues, invalidate };
