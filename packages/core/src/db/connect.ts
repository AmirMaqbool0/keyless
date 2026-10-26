import mongoose from 'mongoose';
import { logger } from '../lib/logger';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string): Promise<typeof mongoose> {
  const conn = await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  // Build indexes declared on schemas (fine for MVP scale; use migrations for big collections).
  await Promise.all(Object.values(conn.models).map((m) => m.syncIndexes()));
  logger.info('MongoDB connected');
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbReady(): boolean {
  return mongoose.connection.readyState === 1;
}
