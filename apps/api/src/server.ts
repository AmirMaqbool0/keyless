import { createApp } from './app';
import { env } from '@keyless/core/config/env';
import { connectDb, disconnectDb } from '@keyless/core/db/connect';
import { createJobHandlers, scheduleMailboxSyncs } from '@keyless/core/ingestion/handlers';
import { logger } from '@keyless/core/lib/logger';
import { ConsoleMailer, ResendMailer } from '@keyless/core/lib/mailer';
import { createStorage } from '@keyless/core/lib/storage';
import { createLlmProvider } from '@keyless/core/llm/index';
import { createQueue } from '@keyless/core/queue/index';
import { MongoWorker } from '@keyless/core/queue/mongo';
import { startBullWorker } from '@keyless/core/queue/bullmq';

async function main(): Promise<void> {
  await connectDb(env.MONGO_URI);
  const mailer =
    env.EMAIL_PROVIDER === 'resend' && env.EMAIL_PROVIDER_API_KEY
      ? new ResendMailer(env.EMAIL_PROVIDER_API_KEY, env.EMAIL_FROM)
      : new ConsoleMailer();

  const storage = createStorage();
  const queue = createQueue();

  const app = createApp({
    mailer,
    storage,
    queue,
  });
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on ${env.API_URL}`);
  });

  // Start background worker and mailbox scheduler directly in the process
  // This guarantees queue jobs and IMAP email polling execute continuously on Render
  let stopWorker = async () => {};
  let timer: NodeJS.Timeout | undefined;

  try {
    const handlers = createJobHandlers({ storage, queue, llm: createLlmProvider() });
    if (env.QUEUE_DRIVER === 'bullmq' && env.REDIS_URL) {
      const bullWorker = startBullWorker(env.REDIS_URL, handlers);
      stopWorker = () => bullWorker.close();
    } else {
      const mongoWorker = new MongoWorker(handlers);
      mongoWorker.start();
      stopWorker = () => mongoWorker.stop();
    }

    const tick = () =>
      scheduleMailboxSyncs(queue).catch((err: unknown) =>
        logger.error({ err }, 'Mailbox scheduler failed'),
      );
    void tick();
    timer = setInterval(tick, 30_000);
    logger.info('Embedded worker & mailbox sync loop running in API server');
  } catch (workerErr) {
    logger.error({ err: workerErr }, 'Failed to start embedded worker');
  }

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    if (timer) clearInterval(timer);
    await stopWorker();
    server.close();
    await queue.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start API');
  process.exit(1);
});
