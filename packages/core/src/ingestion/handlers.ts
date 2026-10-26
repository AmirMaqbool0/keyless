import { env } from '../config/env';
import type { Storage } from '../lib/storage';
import { logger } from '../lib/logger';
import type { LlmProvider } from '../llm/types';
import { Mailbox } from '../models/Mailbox';
import { runMailboxSync } from '../mailboxes/sync';
import type { FetchLike } from '../mailboxes/oauth';
import type { JobHandlers, JobQueue } from '../queue/types';
import { classifyEmail, processEmail } from './process';

export type WorkerDeps = { storage: Storage; queue: JobQueue; llm: LlmProvider; fetch?: FetchLike };

/** Every job the worker knows how to run. */
export function createJobHandlers(deps: WorkerDeps): JobHandlers {
  return {
    'process-email': (data) => processEmail(deps, data),
    'classify-email': (data) => classifyEmail(deps, data),
    'mailbox-sync': (data) => runMailboxSync(deps, data),
  };
}

/**
 * Queue a sync for every active connected mailbox that is due. Called on a timer by the worker;
 * the unique key means a slow sync is never queued twice.
 */
export async function scheduleMailboxSyncs(queue: JobQueue): Promise<number> {
  const due = new Date(Date.now() - env.MAILBOX_SYNC_INTERVAL_SEC * 1000);
  const mailboxes = await Mailbox.find(
    {
      type: { $in: ['graph', 'gmail'] },
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
