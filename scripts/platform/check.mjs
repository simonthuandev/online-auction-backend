import { spawnSync } from 'node:child_process';
import { services } from './catalog.mjs';
const command = process.argv[2];
for (const s of services) {
  const args =
    command === 'build'
      ? ['node_modules/@nestjs/cli/bin/nest.js', 'build', s + '-service']
      : [
          'node_modules/typescript/bin/tsc',
          '--noEmit',
          '--incremental',
          'false',
          '-p',
          `apps/${s}-service/tsconfig.app.json`,
        ];
  const r = spawnSync('node', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
