// Preloaded into BOTH test servers (old code and new code):
//  - every database connection uses the throwaway schema
//  - all outbound HTTP is faked (Revizto/ACC membership answers come from the test users); nothing leaves the machine
//  - no polling, no email
const schema = process.env.TEST_SCHEMA;
const pg = require('pg');
const OrigPool = pg.Pool;
pg.Pool = class extends OrigPool {
  constructor(cfg) {
    super(cfg);
    this.on('connect', (c) => c.query(`SET search_path TO ${schema}`));
  }
};

process.env.POLL_ENABLED = 'false';
for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT']) process.env[k] = '';

const axios = require('axios');
const EMAILS = (process.env.TEST_EMAILS || '').split(',').filter(Boolean);
axios.defaults.adapter = async (config) => {
  const url = String(config.url || '');
  const ok = (data) => ({ data, status: 200, statusText: 'OK', headers: {}, config });
  const fail = (status) => {
    const err = new Error(`fake ${status} for ${url}`);
    err.config = config;
    err.response = { status, data: { message: 'blocked in test' }, headers: {}, config };
    throw err;
  };
  if (/revizto\.com\/v5\/project\/[^/]+\/team$/.test(url)) {
    // services/reviztoService.getProjectTeam reads response.data.entities
    return ok({ result: 0, data: { entities: EMAILS.map((email) => ({ email, invited: false, status: 1 })) } });
  }
  if (/revizto\.com\/v5\/license\/[^/]+\/team$/.test(url)) return ok({ entities: [] });
  if (/construction\/admin\/v1\/projects\/[^/]+\/users$/.test(url)) {
    return ok({ results: EMAILS.map((email) => ({ email, status: 'active', accessLevels: { projectAdmin: true } })), pagination: { totalResults: EMAILS.length } });
  }
  return fail(404);
};
