import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { logger } from '../lib/logger';
import {
  DEFAULT_MAX_ATTEMPTS,
  PermanentJobError,
  recordJobFailure,
  type AddJobOptions,
  type JobHandlers,
  type JobName,
  type JobPayloads,
  type JobQueue,
} from './types';

/*
 * BullMQ driver, used when QUEUE_DRIVER=bullmq. Same semantics as the Mongo driver: unique keys,
 * exponential backoff from 5s, permanent failures recorded in ErrorLog.
 * TODO(verify-redis): not exercised in CI (no Redis on the dev machine). The test in
 * test/queue.bullmq.test.ts runs automatically when REDIS_URL is set.
 */

const QUEUE_NAME = 'keyless';

/** BullMQ wants a parsed connection; maxRetriesPerRequest must be null for workers. */
function connection(redisUrl: string) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** Custom job ids must not contain ":" in BullMQ. */
const jobId = (key: string) => key.replace(/:/g, '_');

export class BullQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.queue = new Queue(QUEUE_NAME, { connection: connection(redisUrl) });
  }

  async add<N extends JobName>(
    name: N,
    data: JobPayloads[N],
    opts: AddJobOptions = {},
  ): Promise<void> {
    const id = opts.uniqueKey ? jobId(opts.uniqueKey) : undefined;
    if (id && opts.reset) {
      const existing = await this.queue.getJob(id);
      const state = await existing?.getState();
      if (existing && (state === 'completed' || state === 'failed')) await existing.remove();
    }
    await this.queue.add(name, data, {
      jobId: id,
      delay: opts.delayMs,
      attempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 7 * 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export function startBullWorker(redisUrl: string, handlers: JobHandlers, concurrency = 4): Worker {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const handler = handlers[job.name as JobName] as
        ((data: unknown, ctx: { jobId: string; attempt: number }) => Promise<unknown>) | undefined;
      if (!handler) throw new UnrecoverableError(`No handler for job "${job.name}"`);
      try {
        return await handler(job.data, { jobId: job.id ?? '', attempt: job.attemptsMade + 1 });
      } catch (err) {
        if (err instanceof PermanentJobError) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    { connection: connection(redisUrl), concurrency },
  );
  worker.on('failed', (job, err) => {
    if (!job) return;
    const final = err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (final)
      void recordJobFailure(job.name, job.data as Record<string, unknown>, err, job.attemptsMade);
    else
      logger.warn(
        { job: job.name, attempt: job.attemptsMade, err: err.message },
        'Job failed, will retry',
      );
  });
  logger.info(`BullMQ worker started (${concurrency} concurrent)`);
  return worker;
}
