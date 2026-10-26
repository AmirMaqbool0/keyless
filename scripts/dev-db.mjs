// Zero-install local MongoDB for development (no Docker needed).
// Starts a real mongod (downloaded once by mongodb-memory-server) with data persisted
// in .data/mongo. If something already listens on the port (Docker, a local install),
// it does nothing so the existing database is used.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

const port = Number(process.env.DEV_MONGO_PORT ?? 27017);

function portInUse(p) {
  return new Promise((resolve) => {
    const socket = net.connect({ port: p, host: '127.0.0.1' }, () => {
      socket.end();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

if (await portInUse(port)) {
  console.log(`[dev-db] Port ${port} already in use - using the existing MongoDB.`);
  setInterval(() => {}, 1 << 30);
} else {
  const dbPath = path.resolve('.data/mongo');
  fs.mkdirSync(dbPath, { recursive: true });
  // A single-node replica set so transactions and change streams work like production.
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, name: 'rs0', storageEngine: 'wiredTiger' },
    instanceOpts: [{ port, dbPath }],
  });
  console.log(`[dev-db] MongoDB running at ${replSet.getUri()} (data in ${dbPath})`);
  const stop = async () => {
    await replSet.stop({ doCleanup: false });
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
