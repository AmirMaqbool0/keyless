import { env } from '../config/env';
import { BullQueue } from './bullmq';
import { MongoQueue } from './mongo';
import type { JobQueue } from './types';

export * from './types';

/** The configured queue for enqueueing jobs (API and worker). */
export function createQueue(): JobQueue {
  if (env.QUEUE_DRIVER === 'bullmq') {
    if (!env.REDIS_URL) throw new Error('QUEUE_DRIVER=bullmq needs REDIS_URL');
    return new BullQueue(env.REDIS_URL);
  }
  return new MongoQueue();
}
