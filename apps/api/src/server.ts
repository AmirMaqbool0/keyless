import { createApp } from './app';
import { env } from './config/env';
import { connectDb, disconnectDb } from './db/connect';
import { logger } from './lib/logger';
import { ConsoleMailer } from './lib/mailer';

async function main(): Promise<void> {
  await connectDb(env.MONGO_URI);
  const app = createApp({ mailer: new ConsoleMailer() });
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
