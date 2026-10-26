import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

let mongo: MongoMemoryServer | undefined;

export async function setup(project: TestProject): Promise<void> {
  mongo = await MongoMemoryServer.create();
  project.provide('mongoUri', mongo.getUri());
}

export async function teardown(): Promise<void> {
  await mongo?.stop();
}
