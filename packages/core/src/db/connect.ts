import mongoose from 'mongoose';
import { logger } from '../lib/logger';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string): Promise<typeof mongoose> {
  const cleanUri = uri.trim().replace(/^["']|["']$/g, '');
  const conn = await mongoose.connect(cleanUri, { serverSelectionTimeoutMS: 10_000 });
  // Clean up legacy/rogue indexes that may conflict with active schemas
  try {
    const db = conn.connection.db;
    if (db) {
      const usersCol = db.collection('users');
      const userIndexes = await usersCol.indexes().catch(() => []);
      if (userIndexes.some((i) => i.name === 'username_1')) {
        await usersCol.dropIndex('username_1').catch(() => {});
        logger.info('Cleaned up legacy username_1 index on users');
      }

      const sessionsCol = db.collection('sessions');
      const sessionIndexes = await sessionsCol.indexes().catch(() => []);
      if (sessionIndexes.some((i) => i.name === 'userId_1' && (i as { unique?: boolean }).unique)) {
        await sessionsCol.dropIndex('userId_1').catch(() => {});
        logger.info('Cleaned up legacy unique userId_1 index on sessions');
      }
    }
  } catch {
    // Non-fatal cleanup
  }

  // Ensure declared indexes exist without concurrently dropping old ones or crashing on race conditions
  try {
    await Promise.allSettled(Object.values(conn.models).map((m) => m.createIndexes()));
  } catch (err) {
    logger.warn({ err }, 'Non-fatal error creating schema indexes');
  }
  logger.info('MongoDB connected');
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}
