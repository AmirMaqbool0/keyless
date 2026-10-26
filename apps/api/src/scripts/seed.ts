/**
 * Demo data: one organisation with a user per role. Safe to re-run (skips existing users).
 * All demo users share SEED_PASSWORD (default below) - for local development only.
 */
import type { Role } from '@keyless/shared';
import { env } from '../config/env';
import { connectDb, disconnectDb } from '../db/connect';
import { Organization } from '../models/Organization';
import { User } from '../models/User';
import { hashPassword } from '../modules/auth/service';

const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? 'keyless-demo-1234';
const DEMO_USERS: { name: string; email: string; role: Role }[] = [
  { name: 'Olivia Owner', email: 'owner@demo.keyless.local', role: 'owner' },
  { name: 'Adam Admin', email: 'admin@demo.keyless.local', role: 'admin' },
  { name: 'Rita Reviewer', email: 'reviewer@demo.keyless.local', role: 'reviewer' },
  { name: 'Victor Viewer', email: 'viewer@demo.keyless.local', role: 'viewer' },
];

async function main(): Promise<void> {
  if (env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  await connectDb(env.MONGO_URI);

  const org =
    (await Organization.findOne({ slug: 'demo-wholesale' })) ??
    (await Organization.create({ name: 'Demo Wholesale Ltd', slug: 'demo-wholesale' }));

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const u of DEMO_USERS) {
    const exists = await User.exists({ orgId: org._id, email: u.email, active: true });
    if (exists) continue;
    await User.create({ ...u, orgId: org._id, passwordHash, emailVerifiedAt: new Date() });
    console.log(`Created ${u.role}: ${u.email}`);
  }
  console.log(`\nDemo org "${org.name}" ready. Password for all demo users: ${DEMO_PASSWORD}`);
  await disconnectDb();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
