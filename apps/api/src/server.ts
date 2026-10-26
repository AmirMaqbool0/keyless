import { createApp } from './app';
import { env } from '@keyless/core/config/env';
import { connectDb, disconnectDb } from '@keyless/core/db/connect';
import { logger } from '@keyless/core/lib/logger';
import { ConsoleMailer } from '@keyless/core/lib/mailer';
import { createStorage } from '@keyless/core/lib/storage';
import { createQueue } from '@keyless/core/queue/index';

async function main(): Promise<void> {
  await connectDb(env.MONGO_URI);
  const app = createApp({
    mailer: new ConsoleMailer(),
    storage: createStorage(),
    queue: createQueue(),
  });
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on ${env.API_URL}`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close();
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
