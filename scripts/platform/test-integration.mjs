import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { chdir } from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
chdir(root);
process.env.PLATFORM_INTEGRATION = 'true';
loadEnv();

async function findIntegrationSpecs(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return findIntegrationSpecs(path);
      if (entry.isFile() && entry.name.endsWith('.integration.spec.ts'))
        return [relative(root, path).split(sep).join('/')];
      return [];
    }),
  );
  return nested.flat();
}

const vitestCli = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);
const requiredDatabaseUrls = [
  'AUCTION_DATABASE_URL',
  'ORDER_DATABASE_URL',
  'PAYMENT_DATABASE_URL',
];
const missingDatabaseUrls = requiredDatabaseUrls.filter(
  (name) => !process.env[name],
);
if (missingDatabaseUrls.length > 0) {
  console.error(
    `Missing ${missingDatabaseUrls.join(', ')}. Configure .env or PLATFORM_ENV_FILE before running integration tests.`,
  );
  process.exitCode = 1;
} else {
  const specs = await findIntegrationSpecs(join(root, 'tests'));
  if (specs.length === 0) {
    console.error(
      'No tests matching *.integration.spec.ts were found in tests/.',
    );
    process.exitCode = 1;
  } else {
    const vitest = spawn(process.execPath, [vitestCli, 'run', ...specs], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });

    vitest.on('error', (error) => {
      console.error('Unable to start Vitest integration tests:', error);
      process.exitCode = 1;
    });
    vitest.on('exit', (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  }
}
