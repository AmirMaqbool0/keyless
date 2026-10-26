import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { logger } from '../lib/logger';
import { Job, type JobDoc } from '../models/Job';
import {
  DEFAULT_MAX_ATTEMPTS,
  PermanentJobError,
  backoffMs,
  recordJobFailure,
  type AddJobOptions,
  type JobHandlers,
  type JobName,
  type JobPayloads,
  type JobQueue,
} from './types';

const isDuplicateKey = (err: unknown) =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === 11000;

/** Queue backed by a MongoDB collection: no Redis needed. Fine for one or a few workers. */
export class MongoQueue implements JobQueue {
  async add<N extends JobName>(
    name: N,
    data: JobPayloads[N],
    opts: AddJobOptions = {},
  ): Promise<void> {
    const runAt = new Date(Date.now() + (opts.delayMs ?? 0));
    const orgId = Types.ObjectId.isValid(data.orgId) ? new Types.ObjectId(data.orgId) : undefined;
    try {
      await Job.create({
        name,
        data,
        orgId,
        runAt,
        uniqueKey: opts.uniqueKey,
        maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      });
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      if (opts.reset) {
        // Only finished jobs are reset; a waiting/active one will run anyway.
        await Job.updateOne(
          { uniqueKey: opts.uniqueKey, status: { $in: ['completed', 'failed'] } },
          {
            $set: {
              status: 'waiting',
              attempts: 0,
              runAt,
              data,
              lastError: null,
              finishedAt: null,
            },
          },
        );
      }
    }
  }

  async close(): Promise<void> {}
}

export type MongoWorkerOptions = { concurrency?: number; pollMs?: number; leaseMs?: number };

export class MongoWorker {
  private running = false;
  private lanes: Promise<void>[] = [];
  private readonly id = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  private readonly opts: Required<MongoWorkerOptions>;

  constructor(
    private readonly handlers: JobHandlers,
    opts: MongoWorkerOptions = {},
  ) {
    this.opts = {
      concurrency: opts.concurrency ?? 4,
      pollMs: opts.pollMs ?? 1000,
      leaseMs: opts.leaseMs ?? 5 * 60_000,
    };
  }

  /** Claim the next due job, or a job whose worker died (lease expired). */
  private claim(): Promise<JobDoc | null> {
    const now = new Date();
    return Job.findOneAndUpdate(
      {
        $or: [
          { status: 'waiting', runAt: { $lte: now } },
          { status: 'active', lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: {
          status: 'active',
          lockedUntil: new Date(now.getTime() + this.opts.leaseMs),
          workerId: this.id,
        },
        $inc: { attempts: 1 },
      },
      { sort: { runAt: 1 }, new: true },
    );
  }

  private async run(job: JobDoc): Promise<void> {
    const handler = this.handlers[job.name as JobName] as
      ((data: unknown, ctx: { jobId: string; attempt: number }) => Promise<unknown>) | undefined;
    try {
      if (!handler) throw new PermanentJobError(`No handler for job "${job.name}"`);
      await handler(job.data, { jobId: job._id.toString(), attempt: job.attempts });
      await Job.updateOne(
        { _id: job._id },
        { $set: { status: 'completed', finishedAt: new Date(), lockedUntil: null } },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const final = err instanceof PermanentJobError || job.attempts >= job.maxAttempts;
      if (final) {
        await Job.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'failed',
              lastError: message,
              finishedAt: new Date(),
              lockedUntil: null,
            },
          },
        );
        await recordJobFailure(job.name, job.data, err, job.attempts);
      } else {
        logger.warn(
          { job: job.name, attempt: job.attempts, err: message },
          'Job failed, will retry',
        );
        await Job.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'waiting',
              lastError: message,
              lockedUntil: null,
              runAt: new Date(Date.now() + backoffMs(job.attempts)),
            },
          },
        );
      }
    }
  }

  /** Process due jobs until none are left. Used by tests and one-off scripts. */
  async drain(maxJobs = 1000): Promise<number> {
    let processed = 0;
    for (let job = await this.claim(); job && processed < maxJobs; job = await this.claim()) {
      await this.run(job);
      processed += 1;
    }
    return processed;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const lane = async () => {
      while (this.running) {
        try {
          const job = await this.claim();
          if (job) await this.run(job);
          else await new Promise((r) => setTimeout(r, this.opts.pollMs));
        } catch (err) {
          logger.error({ err }, 'Worker loop error');
          await new Promise((r) => setTimeout(r, this.opts.pollMs));
        }
      }
    };
    this.lanes = Array.from({ length: this.opts.concurrency }, lane);
    logger.info(`Mongo queue worker ${this.id} started (${this.opts.concurrency} lanes)`);
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.lanes);
  }
}
