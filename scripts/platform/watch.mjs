import { watch, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const service = process.argv[2];
if (!/^(auth|product|auction|order|payment|notification)$/.test(service))
  throw Error('Invalid service');
let child,
  building = false,
  again = false,
  stopping = false,
  timer;
async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  const exit = once(current, 'exit');
  current.kill('SIGTERM');
  const force = setTimeout(() => current.kill('SIGKILL'), 7000);
  await exit;
  clearTimeout(force);
}
async function rebuild() {
  if (stopping) return;
  if (building) {
    again = true;
    return;
  }
  building = true;
  try {
    const compiler = spawn(
      'node',
      ['node_modules/@nestjs/cli/bin/nest.js', 'build', service + '-service'],
      { stdio: 'inherit' },
    );
    const [code] = await once(compiler, 'exit');
    if (code === 0 && !stopping) {
      await stopChild();
      child = spawn('node', [`dist/apps/${service}-service/main.js`], {
        stdio: 'inherit',
        env: { ...process.env, SERVICE_NAME: service },
      });
    }
  } finally {
    building = false;
    if (again) {
      again = false;
      void rebuild();
    }
  }
}
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 200);
}
const dirs = [`apps/${service}-service/src`, 'libs/common/src'];
const files = ['tsconfig.json', 'nest-cli.json'];
const watchers = [];
let poll;
if (process.env.WATCH_POLLING === 'true') {
  function snapshot() {
    const entries = [];
    function walk(path) {
      for (const item of readdirSync(path, { withFileTypes: true })) {
        const name = path + '/' + item.name;
        if (item.isDirectory()) walk(name);
        else {
          const s = statSync(name);
          entries.push(name + ':' + s.mtimeMs + ':' + s.size);
        }
      }
    }
    for (const dir of dirs) walk(dir);
    for (const file of files) {
      const s = statSync(file);
      entries.push(file + ':' + s.mtimeMs + ':' + s.size);
    }
    return entries.sort().join('\n');
  }
  let previous = snapshot();
  poll = setInterval(() => {
    const current = snapshot();
    if (current !== previous) {
      previous = current;
      schedule();
    }
  }, 1000);
} else {
  for (const dir of dirs)
    watchers.push(watch(dir, { recursive: true }, schedule));
  for (const file of files) watchers.push(watch(file, schedule));
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(timer);
    clearInterval(poll);
    for (const watcher of watchers) watcher.close();
    await stopChild();
  });
mkdirSync('dist', { recursive: true });
await rebuild();
