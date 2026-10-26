import { env } from '@keyless/core/config/env';
import { connectDb, disconnectDb } from '@keyless/core/db/connect';
import { createJobHandlers, scheduleMailboxSyncs } from '@keyless/core/ingestion/handlers';
import { logger } from '@keyless/core/lib/logger';
import { createStorage } from '@keyless/core/lib/storage';
import { createLlmProvider } from '@keyless/core/llm/index';
import { startBullWorker } from '@keyless/core/queue/bullmq';
import { createQueue } from '@keyless/core/queue/index';
import { MongoWorker } from '@keyless/core/queue/mongo';

const SCHEDULER_TICK_MS = 30_000;

async function main(): Promise<void> {
  await connectDb(env.MONGO_URI);
  const queue = createQueue();
  const handlers = createJobHandlers({ storage: createStorage(), queue, llm: createLlmProvider() });

  let stopWorker: () => Promise<void>;
  if (env.QUEUE_DRIVER === 'bullmq') {
    const worker = startBullWorker(env.REDIS_URL!, handlers);
    stopWorker = () => worker.close();
  } else {
    const worker = new MongoWorker(handlers);
    worker.start();
    stopWorker = () => worker.stop();
  }

  const tick = () =>
    scheduleMailboxSyncs(queue).catch((err: unknown) =>
      logger.error({ err }, 'Mailbox scheduler failed'),
    );
  void tick();
  const timer = setInterval(tick, SCHEDULER_TICK_MS);
  logger.info(
    `Worker running (queue: ${env.QUEUE_DRIVER}, mailbox sync every ${env.MAILBOX_SYNC_INTERVAL_SEC}s)`,
  );

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, finishing current jobs`);
    clearInterval(timer);
    await stopWorker();
    await queue.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start worker');
  process.exit(1);
});
