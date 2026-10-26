import crypto from 'node:crypto';
import express, { Router, type Request } from 'express';
import multer from 'multer';
import { env } from '@keyless/core/config/env';
import {
  MAX_RAW_EMAIL_BYTES,
  mailboxForRecipient,
  receiveRawEmail,
  recipientsFromRaw,
  type IngestDeps,
} from '@keyless/core/ingestion/receive';
import { badRequest, unauthorized } from '@keyless/core/lib/http';
import { logger } from '@keyless/core/lib/logger';

/*
 * Inbound email webhook. Provider-agnostic, accepting the three common shapes:
 *  1. Raw MIME body (Content-Type message/rfc822 or text/plain): Cloudflare Email Workers,
 *     custom relays, our dev tools. Envelope recipients may be passed in X-Envelope-To.
 *  2. JSON { RawEmail, OriginalRecipient } (Postmark inbound with "include raw email" enabled)
 *     or { raw, to } (generic). TODO(verify-api): confirm Postmark field names when wiring it up.
 *  3. multipart/form-data with an `email` field holding raw MIME and an `envelope` JSON field
 *     (SendGrid Inbound Parse with "POST the raw, full MIME message").
 * Auth: shared secret in the X-Inbound-Secret header, or as the password of HTTP Basic auth
 * (for providers that only let you put credentials in the URL).
 */

function secretMatches(req: Request): boolean {
  const expected = env.INBOUND_WEBHOOK_SECRET;
  if (!expected) return env.NODE_ENV !== 'production'; // enforced at startup in production
  let given = req.get('x-inbound-secret');
  const basic = req.get('authorization');
  if (!given && basic?.startsWith('Basic ')) {
    given = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  }
  if (!given) return false;
  const a = Buffer.from(crypto.createHash('sha256').update(given).digest());
  const b = Buffer.from(crypto.createHash('sha256').update(expected).digest());
  return crypto.timingSafeEqual(a, b);
}

function splitAddresses(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(splitAddresses);
  return typeof v === 'string'
    ? v
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

const multipart = multer({
  storage: multer.memoryStorage(),
  limits: { fieldSize: MAX_RAW_EMAIL_BYTES, fileSize: MAX_RAW_EMAIL_BYTES },
});
const rawBody = express.raw({ type: () => true, limit: MAX_RAW_EMAIL_BYTES + 1024 * 1024 });

/** Parse whichever shape the provider sent into raw MIME + envelope recipients. */
function extract(req: Request): { raw: Buffer; envelope: string[] } {
  const envelope = splitAddresses(req.get('x-envelope-to'));
  if (req.is('multipart/form-data')) {
    const body = req.body as Record<string, string>;
    const file = (req.files as Express.Multer.File[] | undefined)?.find(
      (f) => f.fieldname === 'email',
    );
    const raw = file?.buffer ?? (body.email ? Buffer.from(body.email, 'utf8') : undefined);
    if (!raw) throw badRequest('Missing "email" field with the raw message');
    try {
      envelope.push(...splitAddresses((JSON.parse(body.envelope ?? '{}') as { to?: unknown }).to));
    } catch {
      /* envelope is optional */
    }
    return { raw, envelope };
  }
  const body = req.body as Buffer;
  if (req.is('application/json')) {
    const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    const raw = json.RawEmail ?? json.raw;
    if (typeof raw !== 'string') throw badRequest('JSON body needs a RawEmail or raw field');
    envelope.push(...splitAddresses(json.OriginalRecipient), ...splitAddresses(json.to));
    return { raw: Buffer.from(raw, json.encoding === 'base64' ? 'base64' : 'utf8'), envelope };
  }
  return { raw: body, envelope };
}

export function inboundWebhookRouter(deps: IngestDeps): Router {
  const r = Router();
  r.post(
    '/',
    (req, res, next) =>
      req.is('multipart/form-data') ? multipart.any()(req, res, next) : rawBody(req, res, next),
    async (req, res) => {
      if (!secretMatches(req))
        throw unauthorized('Bad inbound webhook secret', 'BAD_WEBHOOK_SECRET');
      const { raw, envelope } = extract(req);
      const mailbox = await mailboxForRecipient([...envelope, ...recipientsFromRaw(raw)]);
      // 202 rather than 4xx: providers retry errors, and retrying won't make an unknown address known.
      if (!mailbox) {
        logger.warn({ envelope }, 'Inbound email for an unknown address was dropped');
        res.status(202).json({ accepted: false, reason: 'unknown_recipient' });
        return;
      }
      if (mailbox.status === 'paused') {
        res.status(202).json({ accepted: false, reason: 'mailbox_paused' });
        return;
      }
      const { email, duplicate } = await receiveRawEmail(deps, {
        orgId: mailbox.orgId,
        mailboxId: mailbox._id,
        source: 'forwarding',
        raw,
      });
      res.status(200).json({ accepted: true, emailId: email._id.toString(), duplicate });
    },
  );
  return r;
}
