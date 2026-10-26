import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { CSRF_HEADER, type Role } from '@keyless/shared';
import { createApp } from '../src/app';
import { ConsoleMailer } from '../src/lib/mailer';
import { LocalStorage } from '../src/lib/storage';
import { Organization } from '../src/models/Organization';
import { User } from '../src/models/User';
import { hashPassword } from '../src/modules/auth/service';

export const PASSWORD = 'correct-horse-battery';

/** Each test file gets its own database on the shared in-memory server. */
export function useTestApp() {
  const mailer = new ConsoleMailer();
  const storage = new LocalStorage(path.join(os.tmpdir(), `keyless-test-${crypto.randomUUID()}`));
  const app = createApp({ mailer, storage });

  beforeAll(async () => {
    await mongoose.connect(process.env.MONGO_URI!, { dbName: `test_${crypto.randomUUID()}` });
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  });
  beforeEach(async () => {
    mailer.outbox.length = 0;
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });
  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  /** A cookie-keeping client that sends the CSRF header like the web app does. */
  async function client() {
    const agent = request.agent(app);
    const first = await agent.get('/api/auth/me');
    const csrf = first.headers[CSRF_HEADER] as string;
    return {
      agent,
      get: (url: string) => agent.get(url),
      post: (url: string, body?: object) => agent.post(url).set(CSRF_HEADER, csrf).send(body),
      patch: (url: string, body?: object) => agent.patch(url).set(CSRF_HEADER, csrf).send(body),
      delete: (url: string) => agent.delete(url).set(CSRF_HEADER, csrf),
      upload: (
        url: string,
        fields: Record<string, string>,
        file: { name: string; content: string | Buffer },
      ) => {
        let req = agent.post(url).set(CSRF_HEADER, csrf);
        for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
        return req.attach('file', Buffer.from(file.content), file.name);
      },
    };
  }

  /** Create a verified user directly (fast path for tests that are not about sign-up). */
  async function createUser(opts: { role: Role; orgId?: mongoose.Types.ObjectId; email?: string }) {
    const orgId =
      opts.orgId ??
      (await Organization.create({ name: 'Org', slug: `org-${crypto.randomUUID()}` }))._id;
    const user = await User.create({
      orgId,
      name: `${opts.role} user`,
      email: opts.email ?? `${opts.role}-${crypto.randomUUID().slice(0, 8)}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      role: opts.role,
      emailVerifiedAt: new Date(),
    });
    return user;
  }

  async function loginAs(email: string) {
    const c = await client();
    const res = await c.post('/api/auth/login', { email, password: PASSWORD });
    if (res.status !== 200 || res.body.status !== 'ok')
      throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    return c;
  }

  /** Pull the `token` query param out of the most recent email to `to`. */
  function tokenFromLastEmail(to: string): string {
    const mail = mailer.outbox.find((m) => m.to === to);
    const match = mail?.text.match(/token=([A-Za-z0-9_\-%]+)/);
    if (!match?.[1]) throw new Error(`no token email for ${to}`);
    return decodeURIComponent(match[1]);
  }

  return { app, mailer, client, createUser, loginAs, tokenFromLastEmail };
}
