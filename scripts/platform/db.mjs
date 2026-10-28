import { spawnSync } from 'node:child_process';
import { loadEnv, services } from './env.mjs';
loadEnv();
const [action, target = 'all', name] = process.argv.slice(2);
for (const s of target === 'all'
  ? services
  : [target.replace(/-service$/, '')]) {
  if (!services.includes(s)) throw Error('Unknown service');
  const schema = `apps/${s}-service/prisma/schema.prisma`;
  if (action === 'dev') {
    const { readFileSync, writeFileSync } = await import('node:fs');
    // Prisma resolves generator output relative to this file, so create a temporary schema beside the real one.
    const temporary = `apps/${s}-service/prisma/.migration-dev.prisma`;
    const source = readFileSync(schema, 'utf8');
    const url = new URL(process.env[s.toUpperCase() + '_DATABASE_URL']);
    url.pathname = '/' + s + '_shadow';
    process.env.PLATFORM_SHADOW_DATABASE_URL = url.toString();
    writeFileSync(
      temporary,
      source.replace(
        /provider\s*=\s*"postgresql"/,
        'provider = "postgresql"\n shadowDatabaseUrl = env("PLATFORM_SHADOW_DATABASE_URL")',
      ),
    );
    const result = spawnSync(
      'node_modules/.bin/prisma',
      [
        'migrate',
        'dev',
        '--skip-generate',
        '--schema',
        temporary,
        '--name',
        name || 'update',
      ],
      { stdio: 'inherit', env: process.env },
    );
    const { unlinkSync } = await import('node:fs');
    unlinkSync(temporary);
    if (result.status !== 0) process.exit(result.status || 1);
    const generated = spawnSync(
      'node_modules/.bin/prisma',
      ['generate', '--schema', schema],
      { stdio: 'inherit', env: process.env },
    );
    if (generated.status !== 0) process.exit(generated.status || 1);
    continue;
  }
  const args =
    action === 'generate'
      ? ['generate']
      : action === 'deploy'
        ? ['migrate', 'deploy']
        : action === 'dev'
          ? ['migrate', 'dev', '--name', name || 'update']
          : ['validate'];
  const result = spawnSync(
    'node_modules/.bin/prisma',
    [...args, '--schema', schema],
    { stdio: 'inherit', env: process.env },
  );
  if (result.status !== 0) process.exit(result.status || 1);
}
