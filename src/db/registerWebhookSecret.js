/**
 * db/registerWebhookSecret.js
 * Registers WEBHOOK_SECRET with Autodesk (APS Webhooks "secret token"), which
 * makes every webhook delivery carry an X-Adsk-Signature header that
 * services/webhookSignature.js can verify.
 *
 *   npm run webhook:secret                 CHECK only: is the secret well-formed? No network, nothing sent.
 *   npm run webhook:secret -- --apply      POST it to Autodesk (a new token).
 *   npm run webhook:secret -- --replace    PUT it (the app already has a token registered — e.g. to change it).
 *
 * The secret is read from WEBHOOK_SECRET (.env or the shell) and is never printed.
 * The same value MUST be set as WEBHOOK_SECRET on Render. A token is per Autodesk
 * APP (client id), so it applies to every webhook the app has registered.
 *
 * Endpoint (Autodesk APS Webhooks v1, from the docs' outline — the reference pages
 * could not be machine-read, so the exact response is printed for you to check):
 *   POST|PUT https://developer.api.autodesk.com/webhooks/v1/tokens   body {"token": "<secret>"}
 *   authenticated with a 2-legged (client-credentials) token.
 */
require('dotenv').config();
const axios = require('axios');

const APS_BASE = 'https://developer.api.autodesk.com';
const SCOPE = process.env.WEBHOOK_TOKEN_SCOPE || 'data:read data:write';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const replace = args.includes('--replace');
  const secret = process.env.WEBHOOK_SECRET || '';
  const problems = [];
  if (!secret) problems.push('WEBHOOK_SECRET is not set.');
  else if (!/^[A-Za-z0-9]{32,64}$/.test(secret)) problems.push(`WEBHOOK_SECRET must be 32-64 letters/digits (it is ${secret.length} characters${/^[A-Za-z0-9]*$/.test(secret) ? '' : ', with other characters in it'}).`);
  if (!process.env.APS_CLIENT_ID || !process.env.APS_CLIENT_SECRET) problems.push('APS_CLIENT_ID / APS_CLIENT_SECRET are not set.');
  console.log(`WEBHOOK_SECRET: ${secret ? `set, ${secret.length} characters` : 'not set'}`);
  console.log(`WEBHOOK_SIGNATURE_MODE here: ${process.env.WEBHOOK_SIGNATURE_MODE || '(not set -> log)'}`);
  if (problems.length) {
    problems.forEach((p) => console.log('PROBLEM: ' + p));
    process.exitCode = 1;
    return;
  }
  if (!apply && !replace) {
    console.log('Looks fine. Nothing was sent. Re-run with --apply to register it with Autodesk (or --replace if one is already registered).');
    return;
  }

  // A 2-legged token for the app itself.
  let accessToken;
  try {
    const { data } = await axios.post(
      `${APS_BASE}/authentication/v2/token`,
      new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(`${process.env.APS_CLIENT_ID}:${process.env.APS_CLIENT_SECRET}`).toString('base64') } }
    );
    accessToken = data.access_token;
  } catch (err) {
    console.error(`Couldn't get an app token from Autodesk (scope "${SCOPE}"): ${err.response?.status || ''} ${JSON.stringify(err.response?.data || err.message)}`);
    process.exitCode = 1;
    return;
  }

  const url = `${APS_BASE}/webhooks/v1/tokens${replace ? '/@me' : ''}`;
  try {
    const res = await axios({ method: replace ? 'PUT' : 'POST', url, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, data: { token: secret } });
    console.log(`Autodesk answered ${res.status} ${res.statusText || ''}. ${replace ? 'Replaced' : 'Registered'} the secret token.`);
    console.log('Next: set the SAME WEBHOOK_SECRET on Render, then watch the logs for "[webhook] Signature verified." on a real delivery.');
  } catch (err) {
    console.error(`Autodesk refused: ${err.response?.status || ''} ${JSON.stringify(err.response?.data || err.message)}`);
    if (err.response?.status === 409) console.error('A token seems to be registered already — use --replace to change it.');
    process.exitCode = 1;
  }
}

main();
