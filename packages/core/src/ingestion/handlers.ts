import { env } from '../config/env';
import type { Storage } from '../lib/storage';
import { logger } from '../lib/logger';
import type { LlmProvider } from '../llm/types';
import { Mailbox } from '../models/Mailbox';
import { runMailboxSync } from '../mailboxes/sync';
import type { FetchLike } from '../mailboxes/oauth';
import type { JobHandlers, JobQueue } from '../queue/types';
import { runExtraction } from '../extraction/job';
import { buildOrdersForEmail } from '../matching/job';
import { executeOrderPush } from '../connectors/pushJob';
import { classifyEmail, processEmail } from './process';

import { encrypt } from '../lib/crypto';
import { Organization } from '../models/Organization';

export type WorkerDeps = { storage: Storage; queue: JobQueue; llm: LlmProvider; fetch?: FetchLike };

/** Ensures service@karamfoodproducts.com.pk is registered as an IMAP mailbox for all organizations. */
export async function ensureDefaultHostingerMailbox(): Promise<void> {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const orgs = await Organization.find({}).lean();
    for (const org of orgs) {
      const exists = await Mailbox.findOne({
        orgId: org._id,
        type: 'imap',
        address: 'service@karamfoodproducts.com.pk',
      });
      if (!exists) {
        const tokensEnc = encrypt(
          JSON.stringify({
            host: 'imap.hostinger.com',
            port: 993,
            secure: true,
            user: 'service@karamfoodproducts.com.pk',
            pass: '4MM5by1d0+$v',
          }),
        );
        await Mailbox.create({
          orgId: org._id,
          type: 'imap',
          name: 'Hostinger Business Mail',
          address: 'service@karamfoodproducts.com.pk',
          folder: 'INBOX',
          tokensEnc,
          status: 'active',
        });
        logger.info({ orgId: org._id }, 'Auto-provisioned Hostinger IMAP mailbox for org');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to ensure Hostinger mailbox');
  }
}

/** Every job the worker knows how to run. */
export function createJobHandlers(deps: WorkerDeps): JobHandlers {
  return {
    'process-email': (data) => processEmail(deps, data),
    'classify-email': (data) => classifyEmail(deps, data),
    'extract-email': (data) => runExtraction(deps, data),
    'build-orders': (data) => buildOrdersForEmail(data, deps),
    'mailbox-sync': (data) => runMailboxSync(deps, data),
    'push-order': (data, ctx) => executeOrderPush(deps, data, ctx),
  };
}

/**
 * Queue a sync for every active connected mailbox that is due. Called on a timer by the worker;
 * the unique key means a slow sync is never queued twice.
 */
export async function scheduleMailboxSyncs(queue: JobQueue): Promise<number> {
  await ensureDefaultHostingerMailbox();
  const due = new Date(Date.now() - env.MAILBOX_SYNC_INTERVAL_SEC * 1000);
  const mailboxes = await Mailbox.find(
    {
      type: { $in: ['graph', 'gmail', 'imap'] },
      status: 'active',
      $or: [{ lastSyncAt: null }, { lastSyncAt: { $lt: due } }],
    },
    { orgId: 1 },
  ).setOptions({ skipTenant: true });
  for (const m of mailboxes) {
    await queue.add(
      'mailbox-sync',
      { orgId: m.orgId.toString(), mailboxId: m._id.toString() },
      { uniqueKey: `mailbox-sync:${m._id}`, reset: true, maxAttempts: 3 },
    );
  }
  if (mailboxes.length) logger.debug(`Queued ${mailboxes.length} mailbox syncs`);
  return mailboxes.length;
}
