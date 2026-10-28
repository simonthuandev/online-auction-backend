import { writeFileSync, readFileSync } from 'node:fs';
import { eventSchemas, gateway, documents } from './catalog.mjs';
const check = process.argv.includes('--check');
function write(path, content) {
  if (check) {
    if (readFileSync(path, 'utf8') !== content)
      throw Error(`Contract drift: ${path}`);
  } else writeFileSync(path, content);
}
function type(s, prefix = '') {
  if (s.$ref) return prefix + s.$ref.split('/').at(-1);
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (s.anyOf) return s.anyOf.map((v) => type(v, prefix)).join(' | ');
  if (Array.isArray(s.type))
    return s.type.map((t) => type({ ...s, type: t }, prefix)).join(' | ');
  if (s.type === 'object')
    return (
      '{ ' +
      Object.entries(s.properties || {})
        .map(
          ([k, v]) =>
            `${JSON.stringify(k)}${(s.required || []).includes(k) ? '' : '?'}: ${type(v, prefix)};`,
        )
        .join(' ') +
      ' }'
    );
  if (s.type === 'array') return `Array<${type(s.items, prefix)}>`;
  return (
    {
      string: 'string',
      integer: 'number',
      number: 'number',
      boolean: 'boolean',
      null: 'null',
    }[s.type] || 'unknown'
  );
}
const eventName = (s) =>
  s.properties.eventName.const
    .split('.')
    .map((x) => x[0].toUpperCase() + x.slice(1))
    .join('') + 'Event';
const schemas = eventSchemas();
write(
  'libs/common/src/contracts/events.generated.ts',
  '// Generated from contracts/events; run npm run contracts:generate.\n' +
    schemas.map((s) => `export type ${eventName(s)} = ${type(s)};`).join('\n') +
    '\nexport type IntegrationEvent = ' +
    schemas.map(eventName).join(' | ') +
    ';\n',
);
const docs = documents();
const prefix = (doc) =>
  doc['x-service'][0].toUpperCase() + doc['x-service'].slice(1);
const definitions = docs.flatMap((doc) =>
  Object.entries(doc.components.schemas).map(
    ([name, schema]) =>
      `export type ${prefix(doc)}${name} = ${type(schema, prefix(doc))};`,
  ),
);
const operations = (name) =>
  `export type ${name} = { ` +
  docs
    .flatMap((doc) =>
      Object.values(doc.paths).flatMap((ops) =>
        Object.values(ops).map(
          (op) =>
            `${JSON.stringify(op.operationId)}: ${type(name === 'HttpRequests' ? op.requestBody?.content['application/json'].schema || {} : Object.entries(op.responses).find(([code]) => code.startsWith('2'))?.[1].content?.['application/json'].schema || {}, prefix(doc))};`,
        ),
      ),
    )
    .join(' ') +
  ' };';
write(
  'libs/common/src/contracts/http.generated.ts',
  '// Generated from service-owned contracts/openapi; run npm run contracts:generate.\n' +
    definitions.join('\n') +
    '\n' +
    operations('HttpRequests') +
    '\n' +
    operations('HttpResponses') +
    '\n',
);
write(
  'krakend/krakend.json',
  JSON.stringify(gateway('docker', {}), null, 2) + '\n',
);
console.log(
  check ? 'Contracts match generated artifacts.' : 'Contracts generated.',
);
