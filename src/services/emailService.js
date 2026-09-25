/**
 * services/emailService.js
 * Generic SMTP email sending (via nodemailer) — works with Gmail,
 * SendGrid, Postmark, Resend's SMTP relay, or an in-house mail server,
 * rather than locking into one vendor's proprietary API. If SMTP env
 * vars aren't set, isConfigured() returns false and callers should treat
 * "added to the team" and "email sent" as separate outcomes — the person
 * can still sign in even if the email never went out.
 */
const nodemailer = require('nodemailer');

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function _transport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const _escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function _send({ to, subject, text, html }) {
  if (!isConfigured()) {
    throw new Error('SMTP not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS to send email.');
  }
  await _transport().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
}

async function sendInviteEmail({ toEmail, invitedByEmail, appUrl, role }) {
  await _send({
    to: toEmail,
    subject: `You've been added to Revizto ↔ ACC Sync`,
    text: `${invitedByEmail} added you as a ${role} on Revizto ↔ ACC Sync.\n\nSign in here with ${toEmail}: ${appUrl}\nThe first time, leave the password blank — we'll email you a code to create one.`,
    html: `<p>${_escape(invitedByEmail)} added you as a <strong>${_escape(role)}</strong> on Revizto ↔ ACC Sync.</p>
           <p><a href="${_escape(appUrl)}">Sign in here</a> with ${_escape(toEmail)}. The first time, leave the password blank — we'll email you a code to create one.</p>`,
  });
}

/**
 * The 6-digit code for creating a password ('set' — first sign-in) or
 * resetting one ('reset' — forgot password). Entered on the sign-in page.
 */
async function sendPasswordCodeEmail({ toEmail, code, purpose, validMinutes }) {
  const isReset = purpose === 'reset';
  await _send({
    to: toEmail,
    subject: `${code} is your Revizto ↔ ACC Sync code`,
    text: isReset
      ? `Your code to reset the password for ${toEmail} is ${code}.\nIt expires in ${validMinutes} minutes.\n\nIf you didn't ask for this, ignore this email — your password won't change.`
      : `Your code to create a password for ${toEmail} is ${code}.\nIt expires in ${validMinutes} minutes.`,
    html: `<p>Your code to ${isReset ? 'reset the password' : 'create a password'} for ${_escape(toEmail)} is:</p>
           <p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${code}</p>
           <p>It expires in ${validMinutes} minutes.${isReset ? " If you didn't ask for this, ignore this email — your password won't change." : ''}</p>`,
  });
}

module.exports = { isConfigured, sendInviteEmail, sendPasswordCodeEmail };
