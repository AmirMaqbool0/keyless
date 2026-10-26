import crypto from 'node:crypto';

/** URL-safe random token for emails/sessions. Only its hash is ever stored. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
