import { readFileSync, readdirSync } from 'node:fs';
export const services = [
  'auth',
  'product',
  'auction',
  'order',
  'payment',
  'notification',
];
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
export const documents = () =>
  services.map((s) => readJson(`contracts/openapi/${s}.json`));
export const eventSchemas = () =>
  readdirSync('contracts/events')
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => readJson(`contracts/events/${n}`));
export function gateway(mode = 'docker', settings = process.env) {
  const endpoints = documents().flatMap((doc) =>
    Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops)
        .filter(([, op]) => op['x-auth'] !== 'internal')
        .map(([method, op]) => ({
          endpoint: path,
          method: method.toUpperCase(),
          output_encoding: 'no-op',
          timeout: '5000ms',
          input_headers: [
            'Authorization',
            'Content-Type',
            'Idempotency-Key',
            'X-Request-Id',
            'X-Correlation-Id',
          ],
          input_query_strings: ['*'],
          ...(op['x-auth'] === 'bearer'
            ? {
                extra_config: {
                  'auth/validator': {
                    alg: 'RS256',
                    disable_jwk_security: true,
                    jwk_local_path: '/etc/krakend/keys/jwk.json',
                    issuer: settings.JWT_ISSUER || 'online-auction',
                    audience: [settings.JWT_AUDIENCE || 'online-auction-api'],
                    cache: false,
                  },
                },
              }
            : {}),
          backend: [
            {
              host: [
                `http://${mode === 'host' ? 'host.docker.internal' : doc['x-service'] + '-service'}:${mode === 'host' ? settings[doc['x-service'].toUpperCase() + '_PORT'] || doc['x-port'] : doc['x-port']}`,
              ],
              url_pattern: op['x-backend-path'],
              method: method.toUpperCase(),
              encoding: 'no-op',
            },
          ],
        })),
    ),
  );
  return {
    version: 3,
    name: 'Online Auction API',
    port: 8080,
    timeout: '5000ms',
    extra_config: {
      'security/cors': {
        allow_origins: (
          settings.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173'
        ).split(','),
        allow_methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allow_headers: [
          'Authorization',
          'Content-Type',
          'Idempotency-Key',
          'X-Request-Id',
          'X-Correlation-Id',
        ],
        expose_headers: ['X-Request-Id'],
        max_age: '12h',
      },
    },
    endpoints,
  };
}
