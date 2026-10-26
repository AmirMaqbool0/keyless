/**
 * Demo data: one organisation with a user per role, plus a 5,000-product catalogue, customers,
 * prices and cross-references from the demo ERP. Safe to re-run (everything is upserted).
 * All demo users share SEED_PASSWORD (default below) - for local development only.
 */
import type { Role } from '@keyless/shared';
import { env } from '../config/env';
import { runSync } from '../connectors';
import { connectDb, disconnectDb } from '../db/connect';
import { generateDemoData } from '../demo/generator';
import { accountKey } from '../lib/normalise';
import { Connector } from '../models/Connector';
import { Customer } from '../models/Customer';
import { Organization } from '../models/Organization';
import { upsertCrossReferences } from '../modules/catalogue/upsert';
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

  // Catalogue, customers, prices and cross-references via the demo ERP connector.
  const connector =
    (await Connector.findOne({ orgId: org._id, type: 'mock' })) ??
    (await Connector.create({
      orgId: org._id,
      type: 'mock',
      name: 'Demo ERP (mock)',
      isDefault: true,
    }));
  org.settings.defaultConnector = connector._id.toString();
  await org.save();
  for (const r of await runSync(connector, ['customers', 'products', 'prices'])) {
    console.log(`Synced ${r.entity}: ${r.created} new, ${r.updated} updated`);
  }
  const { crossReferences } = generateDemoData();
  const customers = new Map(
    (await Customer.find({ orgId: org._id }, { accountKey: 1 }).lean()).map((c) => [
      c.accountKey,
      c._id,
    ]),
  );
  const xrefs = await upsertCrossReferences(
    org._id,
    crossReferences.flatMap((x) => {
      const customerId = customers.get(accountKey(x.accountCode));
      return customerId ? [{ ...x, customerId }] : [];
    }),
    'import',
  );
  console.log(`Cross-references: ${xrefs.created} new, ${xrefs.updated} updated`);

  console.log(`\nDemo org "${org.name}" ready. Password for all demo users: ${DEMO_PASSWORD}`);
  await disconnectDb();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
