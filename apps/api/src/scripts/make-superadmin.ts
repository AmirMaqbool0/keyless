/** Usage: pnpm --filter @keyless/api make-superadmin you@example.com */
import { env } from '../config/env';
import { connectDb, disconnectDb } from '../db/connect';
import { User } from '../models/User';

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email) throw new Error('Pass the email address of an existing user');
  await connectDb(env.MONGO_URI);
  const user = await User.findOneAndUpdate(
    { email, active: true },
    { isSuperAdmin: true },
    { new: true },
  ).setOptions({
    skipTenant: true,
  });
  console.log(
    user ? `${email} is now a platform super-admin` : `No active user with email ${email}`,
  );
  await disconnectDb();
}

main().catch(async (err: unknown) => {
  console.error(err);
  await disconnectDb();
  process.exit(1);
});
