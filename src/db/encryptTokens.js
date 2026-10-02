/**
 * db/encryptTokens.js
 * Converts the stored Revizto / ACC tokens between plain text and encrypted
 * (services/tokenCrypto.js). Run with: npm run tokens:encrypt -- <options>
 *
 *   --new-key             print a new random key and stop (touches nothing)
 *   (no option)           DRY RUN: only counts how many values are plain / encrypted
 *   --apply               encrypt every plain value (needs TOKEN_ENCRYPTION_KEY)
 *   --apply --reencrypt   also re-encrypt values made with an older key (rotation)
 *   --apply --decrypt     put everything back to plain text (the way back)
 *
 * Safe to run repeatedly, and while the app is running: each row is locked
 * for its own short transaction, so a token refresh happening at the same
 * moment can't be overwritten with an older value. Token values are never
 * printed.
 */
require('dotenv').config();
const pool = require('./pool');
const tokenCrypto = require('../services/tokenCrypto');

const TABLES = [
  { table: 'acc_tokens', columns: ['access_token', 'refresh_token'] },
  { table: 'revizto_tokens', columns: ['access_token', 'refresh_token'] },
];

async function main(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  if (args.has('--new-key')) {
    console.log(tokenCrypto.newKey());
    return null;
  }
  const apply = args.has('--apply');
  const decrypt = args.has('--decrypt');
  const reencrypt = args.has('--reencrypt');
  if (apply && !decrypt && !process.env.TOKEN_ENCRYPTION_KEY) {
    throw new Error('Set TOKEN_ENCRYPTION_KEY first (make one with: npm run tokens:encrypt -- --new-key).');
  }

  const totals = { plain: 0, encrypted: 0, converted: 0, unreadable: 0 };
  for (const { table, columns } of TABLES) {
    const { rows: ids } = await pool.query(`SELECT user_id FROM ${table} ORDER BY user_id`);
    for (const { user_id: userId } of ids) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(`SELECT ${columns.join(', ')} FROM ${table} WHERE user_id = $1 FOR UPDATE`, [userId]);
        const row = rows[0];
        const updates = {};
        for (const column of columns) {
          const value = row[column];
          const aadText = tokenCrypto.aad(table, column, userId);
          if (tokenCrypto.isEncrypted(value)) {
            totals.encrypted++;
            try {
              if (decrypt) updates[column] = tokenCrypto.decrypt(value, aadText);
              else if (reencrypt) updates[column] = tokenCrypto.encrypt(tokenCrypto.decrypt(value, aadText), aadText);
            } catch (err) {
              if (!(err instanceof tokenCrypto.TokenUnreadableError)) throw err;
              totals.unreadable++;
              console.warn(`  ${table} user ${userId} ${column}: ${err.message} — left as is`);
            }
          } else {
            totals.plain++;
            if (!decrypt) updates[column] = tokenCrypto.encrypt(value, aadText);
          }
        }
        const changed = Object.keys(updates);
        if (apply && changed.length) {
          const sets = changed.map((c, i) => `${c} = $${i + 2}`).join(', ');
          await client.query(`UPDATE ${table} SET ${sets} WHERE user_id = $1`, [userId, ...changed.map((c) => updates[c])]);
        }
        if (changed.length) totals.converted += changed.length;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  }
  console.log(
    `${apply ? 'Done' : 'Dry run'}: ${totals.plain} plain and ${totals.encrypted} encrypted values found` +
      `${totals.unreadable ? `, ${totals.unreadable} unreadable (wrong/missing key)` : ''}; ` +
      `${totals.converted} ${apply ? 'converted' : 'would be converted'}.`
  );
  if (!apply) console.log('Nothing was changed. Add --apply to convert.');
  return totals;
}

module.exports = { main };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[tokens] Failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
