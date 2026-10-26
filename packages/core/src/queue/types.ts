import { Types } from 'mongoose';
import { logger } from '../lib/logger';
import { ErrorLog } from '../models/ErrorLog';

/** Every job and its payload. Payloads are plain JSON; ids are strings. */
export type JobPayloads = {
  /** Parse a stored raw email: headers, body, attachments. */
  'process-email': { orgId: string; emailId: string };
  /** Decide what kind of email it is (order, amendment, quote...). */
  'classify-email': { orgId: string; emailId: string };
  /** Read the purchase order(s) out of an email classified as a new order. */
  'extract-email': { orgId: string; emailId: string };
  /** Match, validate and route the extracted orders into Order records. */
  'build-orders': { orgId: string; emailId: string };
  /** Pull new messages from a connected Graph/Gmail mailbox. */
  'mailbox-sync': { orgId: string; mailboxId: string };
};
export type JobName = keyof JobPayloads;

export type AddJobOptions = {
  /** At most one job per key; adding again is a no-op unless `reset` is set. */
  uniqueKey?: string;
  /** Re-run a finished job with the same key (manual "reprocess"). */
  reset?: boolean;
  delayMs?: number;
  maxAttempts?: number;
};

export interface JobQueue {
  add<N extends JobName>(name: N, data: JobPayloads[N], opts?: AddJobOptions): Promise<void>;
  close(): Promise<void>;
}

export type JobContext = { jobId: string; attempt: number };
export type JobHandlers = {
  [N in JobName]: (data: JobPayloads[N], ctx: JobContext) => Promise<unknown>;
};

/** Throw from a handler when retrying cannot help (e.g. the email was deleted). */
export class PermanentJobError extends Error {}

export const DEFAULT_MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;

/** 5s, 10s, 20s, 40s... capped at 10 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), 10 * 60_000);
}

const ENTITY_BY_JOB: Record<
  JobName,
  (d: Record<string, unknown>) => { type: string; id: string } | undefined
> = {
  'process-email': (d) =>
    typeof d.emailId === 'string' ? { type: 'email', id: d.emailId } : undefined,
  'classify-email': (d) =>
    typeof d.emailId === 'string' ? { type: 'email', id: d.emailId } : undefined,
  'extract-email': (d) =>
    typeof d.emailId === 'string' ? { type: 'email', id: d.emailId } : undefined,
  'build-orders': (d) =>
    typeof d.emailId === 'string' ? { type: 'email', id: d.emailId } : undefined,
  'mailbox-sync': (d) =>
    typeof d.mailboxId === 'string' ? { type: 'mailbox', id: d.mailboxId } : undefined,
};

/** Record a job that has failed for good so admins can see and retry it. */
export async function recordJobFailure(
  name: string,
  data: Record<string, unknown>,
  err: unknown,
  attempts: number,
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err, job: name, data }, `Job ${name} failed permanently`);
  const orgId =
    typeof data.orgId === 'string' && Types.ObjectId.isValid(data.orgId) ? data.orgId : undefined;
  if (!orgId) return;
  try {
    await ErrorLog.create({
      orgId,
      jobName: name,
      data,
      entity: ENTITY_BY_JOB[name as JobName]?.(data),
      message: message.slice(0, 2000),
      stack: err instanceof Error ? err.stack?.slice(0, 4000) : undefined,
      attempts,
    });
  } catch (logErr) {
    logger.error({ err: logErr }, 'Could not write ErrorLog');
  }
}
