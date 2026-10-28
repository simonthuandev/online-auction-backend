import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { loadEnv } from './env.mjs';
loadEnv();
if (!process.env.PLATFORM_TEST_PROJECT?.includes('verify'))
  throw Error('Verification project required');
const settings = {
  host: 'localhost',
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
};
const root = new pg.Client({ ...settings, database: process.env.POSTGRES_DB });
await root.connect();
const database = 'auth_upgrade_verify_' + Date.now();
const userId = randomUUID(),
  tokenId = randomUUID();
let local;
const run = (args) => {
  const url = new URL(process.env.AUTH_DATABASE_URL);
  url.username = settings.user;
  url.password = settings.password;
  url.pathname = '/' + database;
  const r = spawnSync('node_modules/.bin/prisma', args, {
    encoding: 'utf8',
    env: { ...process.env, AUTH_DATABASE_URL: url.toString() },
  });
  if (r.status !== 0) throw Error(r.stderr || r.stdout);
};
try {
  await root.query(`CREATE DATABASE "${database}"`);
  local = new pg.Client({ ...settings, database });
  await local.connect();
  const old = [
    '20261003042039_init_user',
    '20261008005738_add_refresh_token_table',
  ];
  for (const migration of old)
    await local.query(
      readFileSync(
        `apps/auth-service/prisma/migrations/${migration}/migration.sql`,
        'utf8',
      ),
    );
  await local.query(
    'INSERT INTO "User" (id,email,password,name,role,"updatedAt") VALUES ($1,$2,$3,$4,$5,now())',
    [
      userId,
      'upgrade@auction.test',
      'hash-fixture',
      'Preserved Seller',
      'SELLER',
    ],
  );
  await local.query(
    'INSERT INTO "RefreshToken" (id,token,"familyId","userId","expiresAt") VALUES ($1,$2,$3,$4,now()+interval \'1 day\')',
    [tokenId, 'legacy-fixture', randomUUID(), userId],
  );
  for (const migration of old)
    run([
      'migrate',
      'resolve',
      '--applied',
      migration,
      '--schema',
      'apps/auth-service/prisma/schema.prisma',
    ]);
  for (let i = 0; i < 2; i++)
    run([
      'migrate',
      'deploy',
      '--schema',
      'apps/auth-service/prisma/schema.prisma',
    ]);
  const user = (
    await local.query('SELECT email,role FROM "User" WHERE id=$1', [userId])
  ).rows[0];
  assert.equal(user.email, 'upgrade@auction.test');
  assert.equal(user.role, 'SELLER');
  const token = (
    await local.query(
      'SELECT "tokenHash","isRevoked" FROM "RefreshToken" WHERE id=$1',
      [tokenId],
    )
  ).rows[0];
  assert.equal(
    token.tokenHash,
    createHash('sha256').update('legacy-fixture').digest('hex'),
  );
  assert.equal(token.isRevoked, true);
  console.log(
    'PASS legacy Auth upgrade preserves User/role, hashes and revokes legacy tokens; repeat deploy is safe.',
  );
  writeFileSync(
    '.local/migration-report.json',
    JSON.stringify({
      at: new Date().toISOString(),
      legacyAuthUpgrade: 'PASS',
      repeatDeploy: 'PASS',
    }) + '\n',
  );
} finally {
  await local?.end();
  await root.query(`DROP DATABASE IF EXISTS "${database}"`);
  await root.end();
}
