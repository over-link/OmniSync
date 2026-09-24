/**
 * services/dashboards.js
 * Read-only aggregates behind the Dashboards page. Everything is grouped
 * by calendar day in the VIEWER's timezone (sent by the page), so a day
 * on a chart means the same thing as a day on their clock — the page then
 * rolls days up into weeks/months for longer ranges.
 */
const pool = require('../db/pool');

const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

/** An IANA zone name we can safely hand to Postgres, else the default. */
function safeTimeZone(tz) {
  if (!tz) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * Issues synced over time: how many currently-linked issues were first
 * synced on each day of [from, to), plus how many already existed before
 * `from` (the running total's starting point). Based on sync_map, so an
 * issue unlinked since drops out of the history entirely — this counts
 * what's linked now, by when it was first linked.
 */
async function syncTimeline({ projectId = null, from, to, tz }) {
  const zone = safeTimeZone(tz);
  const [{ rows: [counts] }, { rows: days }] = await Promise.all([
    pool.query(
      `SELECT count(*) FILTER (WHERE linked_at < $1)::int AS before_range,
              count(*) FILTER (WHERE linked_at IS NULL)::int AS undated,
              count(*)::int AS total
       FROM sync_map WHERE ($2::int IS NULL OR project_id = $2)`,
      [from, projectId]
    ),
    pool.query(
      `SELECT to_char(linked_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, count(*)::int AS linked
       FROM sync_map
       WHERE linked_at >= $1 AND linked_at < $2 AND ($4::int IS NULL OR project_id = $4)
       GROUP BY 1 ORDER BY 1`,
      [from, to, zone, projectId]
    ),
  ]);
  return { beforeRange: counts.before_range, undated: counts.undated, total: counts.total, days };
}

/**
 * Sync activity per day from the audit log: field changes, comments and
 * attachments, by direction — plus errors per day, counted separately
 * since they aren't activity in either direction.
 */
async function activity({ projectId = null, from, to, tz }) {
  const zone = safeTimeZone(tz);
  const { rows } = await pool.query(
    `SELECT to_char(created_at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, direction, action, count(*)::int AS n
     FROM audit_log
     WHERE created_at >= $1 AND created_at < $2
       AND action IN ('field_change', 'comment', 'attachment', 'error')
       AND ($4::int IS NULL OR project_id = $4)
     GROUP BY 1, 2, 3 ORDER BY 1`,
    [from, to, zone, projectId]
  );
  return { rows };
}

module.exports = { syncTimeline, activity };
