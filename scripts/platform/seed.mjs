import { createRequire } from 'node:module';
import bcrypt from 'bcryptjs';
import { loadEnv } from './env.mjs';
loadEnv();
if (process.env.NODE_ENV === 'production')
  throw Error('Development seed is disabled in production');
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client/auth/index.js');
const db = new PrismaClient();
const password = await bcrypt.hash(process.env.SEED_PASSWORD, 10);
try {
  for (const [i, role] of ['ADMIN', 'SELLER', 'USER', 'USER'].entries())
    await db.user.upsert({
      where: {
        email: ['admin', 'seller', 'bidder', 'bidder2'][i] + '@auction.test',
      },
      update: {},
      create: {
        id: `10000000-0000-4000-8000-00000000000${i + 1}`,
        email: ['admin', 'seller', 'bidder', 'bidder2'][i] + '@auction.test',
        password,
        name: role,
        role,
      },
    });
  console.log(
    'Seed ready. Emails: admin/seller/bidder/bidder2@auction.test; password: SEED_PASSWORD in local env.',
  );
} finally {
  await db.$disconnect();
}
