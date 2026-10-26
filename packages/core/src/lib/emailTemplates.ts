import type { MailMessage } from './mailer';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);

function layout(
  to: string,
  subject: string,
  lines: string[],
  action: { label: string; url: string },
): MailMessage {
  const text = [...lines, '', `${action.label}: ${action.url}`, '', '- Keyless'].join('\n');
  const html =
    lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('') +
    `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p><p>- Keyless</p>`;
  return { to, subject, text, html };
}

export const verifyEmailMail = (to: string, name: string, url: string) =>
  layout(
    to,
    'Verify your email for Keyless',
    [`Hi ${name},`, 'Please confirm your email address. This link expires in 24 hours.'],
    { label: 'Verify email', url },
  );

export const resetPasswordMail = (to: string, url: string) =>
  layout(
    to,
    'Reset your Keyless password',
    [
      'Someone asked to reset the password for this account. If it was not you, ignore this email.',
      'This link expires in 1 hour.',
    ],
    { label: 'Reset password', url },
  );

export const inviteMail = (
  to: string,
  inviterName: string,
  orgName: string,
  role: string,
  url: string,
) =>
  layout(
    to,
    `${inviterName} invited you to ${orgName} on Keyless`,
    [
      `${inviterName} has invited you to join ${orgName} on Keyless as a ${role}.`,
      'This invitation expires in 7 days.',
    ],
    { label: 'Accept invitation', url },
  );
