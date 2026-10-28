import { writeFileSync } from 'node:fs';
import { gateway } from './catalog.mjs';
writeFileSync(
  process.argv[2] || '/output/krakend.json',
  JSON.stringify(gateway(process.env.RUNTIME_MODE || 'docker'), null, 2),
);
