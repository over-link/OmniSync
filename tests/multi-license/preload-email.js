// Extra preload for c7test.js: email is faked so "resend invitation" can be tested without sending anything.
//   TEST_SMTP unset / 'off'  -> email is not configured (isConfigured() false)
//   TEST_SMTP = 'ok'         -> configured; each invitation is appended as a JSON line to TEST_MAIL_FILE
//   TEST_SMTP = 'fail'       -> configured, but sending throws
// The mode can be switched while the server runs by writing 'off' | 'ok' | 'fail' into TEST_MODE_FILE.
const fs = require('fs');
const path = require('path');
const emailService = require(path.join(process.cwd(), 'src/services/emailService'));
const mode = () => {
  try {
    if (process.env.TEST_MODE_FILE) return fs.readFileSync(process.env.TEST_MODE_FILE, 'utf8').trim();
  } catch {
    // no file yet
  }
  return process.env.TEST_SMTP || 'off';
};
emailService.isConfigured = () => mode() !== 'off';
emailService.sendInviteEmail = async (mail) => {
  if (mode() === 'fail') throw new Error('smtp down');
  fs.appendFileSync(process.env.TEST_MAIL_FILE, JSON.stringify(mail) + '\n');
};
