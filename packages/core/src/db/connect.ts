import mongoose from 'mongoose';
import { logger } from '../lib/logger';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string): Promise<typeof mongoose> {
  const cleanUri = uri.trim().replace(/^["']|["']$/g, '');
  const conn = await mongoose.connect(cleanUri, { serverSelectionTimeoutMS: 10_000 });
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
