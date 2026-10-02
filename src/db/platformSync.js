/**
 * db/platformSync.js
 * The OPERATOR's pause for the whole platform: stops background syncing (the
 * poll and incoming ACC webhooks) for EVERY license. Separate from each
 * license's own switch on License Administration.
 *
 *   npm run platform:sync              show the state
 *   npm run platform:sync -- pause     pause everything
 *   npm run platform:sync -- resume    resume
 *
 * Resuming is picked up by the next 2-minute tick; each license then syncs
 * again by its own rules (its own switch, hours and state).
 */
require('dotenv').config();
const pool = require('./pool');
const appSettings = require('../services/appSettings');

async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  if (cmd === 'pause') await appSettings.setPlatformSyncPaused(true);
  else if (cmd === 'resume') await appSettings.setPlatformSyncPaused(false);
  else if (cmd) throw new Error('Use: pause | resume (or nothing, to see the state).');
  const paused = await appSettings.isPlatformSyncPaused();
  console.log(`Platform syncing is ${paused ? 'PAUSED for every license' : 'running (each license by its own rules)'}.`);
  return paused;
}

module.exports = { main };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[platform] Failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
