import { readdirSync, readFileSync } from 'node:fs';
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(dir + '/' + e.name) : [dir + '/' + e.name],
  );
}
for (const path of files('apps').filter((p) => p.endsWith('.ts'))) {
  const service = path.split('/')[1].replace('-service', '');
  const source = readFileSync(path, 'utf8');
  if (/from\s+['"][^'"]*apps\//.test(source))
    throw Error('Cross-app import: ' + path);
  for (const match of source.matchAll(/@prisma\/client\/([^/]+)\//g))
    if (match[1] !== service)
      throw Error('Cross-service Prisma import: ' + path);
}
console.log('Service ownership boundaries pass.');
