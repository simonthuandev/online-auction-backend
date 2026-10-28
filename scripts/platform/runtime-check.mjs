import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { loadEnv, services } from './env.mjs';
loadEnv();
const project = process.env.PLATFORM_TEST_PROJECT;
if (!project || !project.includes('verify') || !process.env.PLATFORM_ENV_FILE)
  throw Error('Explicit verification project/env required');
const images =
  process.env.PLATFORM_RUNTIME_IMAGES_PROJECT || 'auction-phase1-runtime';
const override = '.local/runtime-images.json';
writeFileSync(
  override,
  JSON.stringify({
    services: Object.fromEntries(
      services.map((s) => [
        s + '-service',
        { image: images + '-' + s + '-service' },
      ]),
    ),
  }),
);
const args = [
  'compose',
  '-f',
  'docker-compose.yml',
  '-f',
  override,
  '--env-file',
  process.env.PLATFORM_ENV_FILE,
  '-p',
  project,
];
const created = [];
const checks = [];
function docker(parts) {
  const r = spawnSync('docker', parts, { encoding: 'utf8' });
  if (r.status !== 0) throw Error(r.stderr || r.stdout);
  return r.stdout.trim();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (const [i, s] of services.entries()) {
    const name = project + '-runtime-' + s;
    docker([
      ...args,
      'run',
      '-d',
      '--no-deps',
      '--name',
      name,
      '-p',
      `127.0.0.1:${13101 + i}:${3001 + i}`,
      s + '-service',
    ]);
    created.push(name);
    let ready = false;
    for (let n = 0; n < 60; n++) {
      try {
        const r = await fetch(`http://127.0.0.1:${13101 + i}/health/ready`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {}
      await sleep(500);
    }
    assert(
      ready,
      `${s} runtime failed: ` + docker(['logs', '--tail', '15', name]),
    );
    const probe = await fetch(`http://127.0.0.1:${13101 + i}/_platform/probe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-service-key': process.env.PLATFORM_ADMIN_KEY,
      },
      body: '{}',
    });
    assert.equal(probe.status, 404);
    docker([
      'exec',
      name,
      'node',
      '-e',
      "const fs=require('fs');if(fs.existsSync('node_modules/typescript')||fs.existsSync('node_modules/@nestjs/cli')||fs.existsSync('src'))process.exit(1)",
    ]);
    const info = JSON.parse(docker(['inspect', name]))[0];
    assert.notEqual(info.Config.User, 'root');
    assert(!info.Mounts.some((m) => m.Destination.startsWith('/app')));
    checks.push({ service: s, status: 'PASS', image: info.Config.Image });
    console.log(
      'PASS ' + s + ' production image, no demo/compiler/source mounts',
    );
  }
} finally {
  for (const n of created) docker(['rm', '-f', n]);
  writeFileSync(
    '.local/runtime-report.json',
    JSON.stringify({ at: new Date().toISOString(), checks }, null, 2) + '\n',
  );
}
