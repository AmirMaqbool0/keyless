import { Router } from 'express';
import type { ConsoleMailer } from '@keyless/core/lib/mailer';

/** Development-only helpers. Never mounted in production. */
export function devRouter({ mailer }: { mailer: ConsoleMailer }): Router {
  const r = Router();
  r.get('/emails', (_req, res) => {
    res.json({ emails: mailer.outbox });
  });
  return r;
}
