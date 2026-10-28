import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { loadEnv, services } from './env.mjs';
loadEnv();
const mode = process.argv[2];
const compose = (args, env = process.env) => {
  const r = spawnSync('docker', ['compose', ...args], {
    stdio: 'inherit',
    env,
  });
  if (r.status !== 0) process.exit(r.status || 1);
};
if (mode === 'infra') {
  const ps = spawnSync(
    'docker',
    ['compose', 'ps', '--services', '--status', 'running'],
    { encoding: 'utf8' },
  );
  if (ps.stdout?.split('\n').some((n) => n.endsWith('-service')))
    throw Error(
      'Container applications are running. Run docker compose stop <service names> before host mode. Volumes are preserved.',
    );
  compose([
    'up',
    '-d',
    'postgres',
    'redis',
    'rabbitmq',
    'db-bootstrap',
    ...services.map((s) => s + '-migrate'),
  ]);
  compose(['run', '--rm', 'gateway-config'], {
    ...process.env,
    RUNTIME_MODE: 'host',
  });
  compose(['up', '-d', '--no-deps', 'krakend'], {
    ...process.env,
    RUNTIME_MODE: 'host',
  });
  compose(['restart', 'krakend']);
} else if (mode === 'all') {
  for (const s of services)
    await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', () =>
        reject(
          Error(
            `Port for ${s} is already in use; stop container applications first.`,
          ),
        ),
      );
      server.listen(
        Number(process.env[s.toUpperCase() + '_PORT']),
        '0.0.0.0',
        () => server.close(resolve),
      );
    });
  const children = services.map((s) => {
    const child = spawn('node', ['scripts/platform/watch.mjs', s], {
      env: { ...process.env, SERVICE_NAME: s },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b) => process.stdout.write(`[${s}] ${b}`));
    child.stderr.on('data', (b) => process.stderr.write(`[${s}] ${b}`));
    return child;
  });
  let ending = false;
  const stop = () => {
    if (ending) return;
    ending = true;
    for (const c of children) c.kill('SIGTERM');
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
  for (const child of children)
    child.on('exit', (code) => {
      if (!ending) {
        process.exitCode = code || 1;
        stop();
      }
    });
} else throw Error('Expected infra or all');
