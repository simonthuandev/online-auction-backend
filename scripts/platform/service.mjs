import { spawn } from 'node:child_process';
const service = process.env.SERVICE_NAME;
if (!/^(auth|product|auction|order|payment|notification)$/.test(service))
  throw Error('Invalid SERVICE_NAME');
const action = process.argv[2];
const cmd =
  action === 'watch'
    ? ['node', ['scripts/platform/watch.mjs', service]]
    : action === 'migrate'
      ? ['node', ['scripts/platform/db.mjs', 'deploy', service]]
      : ['node', [`dist/apps/${service}-service/main.js`]];
const child = spawn(cmd[0], cmd[1], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 0 : 1);
});
