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

/** Invite: the set-password link doubles as "accept the invite". */
async function sendInviteEmail({ toEmail, invitedByEmail, role, setPasswordUrl }) {
  await _send({
    to: toEmail,
    subject: `You've been added to Revizto ↔ ACC Sync`,
    text: `${invitedByEmail} added you as a ${role} on Revizto ↔ ACC Sync.\n\nSet your password to get started (link valid for 72 hours):\n${setPasswordUrl}`,
    html: `<p>${_escape(invitedByEmail)} added you as a <strong>${_escape(role)}</strong> on Revizto ↔ ACC Sync.</p>
           <p><a href="${_escape(setPasswordUrl)}">Set your password</a> to get started. This link is valid for 72 hours.</p>`,
  });
}

/**
 * purpose 'set': first password for an existing/invited account.
 * purpose 'reset': "forgot password".
 */
async function sendPasswordLinkEmail({ toEmail, url, purpose }) {
  const isReset = purpose === 'reset';
  const validFor = isReset ? '1 hour' : '72 hours';
  await _send({
    to: toEmail,
    subject: isReset ? 'Reset your Revizto ↔ ACC Sync password' : 'Set your Revizto ↔ ACC Sync password',
    text: isReset
      ? `Someone (hopefully you) asked to reset the password for ${toEmail}.\n\nReset it here (valid for ${validFor}):\n${url}\n\nIf this wasn't you, ignore this email — your password won't change.`
      : `Set a password for ${toEmail} to sign in to Revizto ↔ ACC Sync (link valid for ${validFor}):\n${url}`,
    html: isReset
      ? `<p>Someone (hopefully you) asked to reset the password for ${_escape(toEmail)}.</p>
         <p><a href="${_escape(url)}">Reset your password</a> (valid for ${validFor}).</p>
         <p>If this wasn't you, ignore this email — your password won't change.</p>`
      : `<p><a href="${_escape(url)}">Set a password</a> for ${_escape(toEmail)} to sign in to Revizto ↔ ACC Sync (valid for ${validFor}).</p>`,
  });
}

module.exports = { isConfigured, sendInviteEmail, sendPasswordLinkEmail };
