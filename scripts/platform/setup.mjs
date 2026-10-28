import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, generateKeyPairSync, createPublicKey } from 'node:crypto';
export function setup(envFile = process.env.PLATFORM_ENV_FILE || '.env') {
  mkdirSync('.local/keys', { recursive: true });
  const old = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  const entries = Object.fromEntries(
    old
      .split('\n')
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')];
      }),
  );
  const defaults = {
    LOCAL_GID: String(process.getgid?.() || 1000),
    POSTGRES_USER: 'admin',
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    POSTGRES_DB: 'root_db',
    POSTGRES_PORT: '5432',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: randomBytes(24).toString('hex'),
    RABBITMQ_PORT: '5672',
    RABBITMQ_MANAGEMENT_PORT: '15672',
    RABBITMQ_USER: 'auction',
    RABBITMQ_PASSWORD: randomBytes(24).toString('hex'),
    API_GATEWAY_PORT: '8080',
    JWT_ISSUER: 'online-auction',
    JWT_AUDIENCE: 'online-auction-api',
    JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
    JWT_PRIVATE_KEY_PATH: '.local/keys/private.pem',
    JWT_PUBLIC_KEY_PATH: '.local/keys/public.pem',
    JWT_KEY_ID: 'auction-dev-v1',
    INTERNAL_AUCTION_KEY: randomBytes(32).toString('hex'),
    INTERNAL_PAYMENT_KEY: randomBytes(32).toString('hex'),
    PLATFORM_ADMIN_KEY: randomBytes(32).toString('hex'),
    CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173',
    PLATFORM_DEMO_ENABLED: 'true',
    NODE_ENV: 'development',
    SEED_PASSWORD: randomBytes(16).toString('hex'),
  };
  const merged = { ...defaults, ...entries };
  for (const [k, v] of Object.entries(defaults)) if (!merged[k]) merged[k] = v;
  for (const [i, s] of [
    'auth',
    'product',
    'auction',
    'order',
    'payment',
    'notification',
  ].entries()) {
    const k = s.toUpperCase();
    merged[k + '_PORT'] ||= String(3001 + i);
    merged[k + '_DB_USER'] ||= s + '_app';
    merged[k + '_DB_PASSWORD'] ||= randomBytes(24).toString('hex');
    // Keep existing local URLs; new installs receive isolated role URLs.
    merged[k + '_DATABASE_URL'] ||=
      `postgresql://${merged[k + '_DB_USER']}:${encodeURIComponent(merged[k + '_DB_PASSWORD'])}@localhost:${merged.POSTGRES_PORT}/${s}_db`;
    merged[k + '_SERVICE_URL'] ||= `http://localhost:${merged[k + '_PORT']}`;
  }
  merged.REDIS_URL ||= `redis://:${merged.REDIS_PASSWORD}@localhost:${merged.REDIS_PORT}`;
  // Replace legacy guest URL only; RabbitMQ guest cannot be used across container networks.
  if (!merged.RABBITMQ_URL || merged.RABBITMQ_URL.includes('guest:guest'))
    merged.RABBITMQ_URL = `amqp://${merged.RABBITMQ_USER}:${encodeURIComponent(merged.RABBITMQ_PASSWORD)}@localhost:${merged.RABBITMQ_PORT}`;
  if (!existsSync('.local/keys/private.pem')) {
    const k = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync('.local/keys/private.pem', k.privateKey, { mode: 0o640 });
    writeFileSync('.local/keys/public.pem', k.publicKey);
  }
  const jwk = createPublicKey(readFileSync('.local/keys/public.pem')).export({
    format: 'jwk',
  });
  writeFileSync(
    '.local/keys/jwk.json',
    JSON.stringify(
      { keys: [{ ...jwk, kid: merged.JWT_KEY_ID, use: 'sig', alg: 'RS256' }] },
      null,
      2,
    ) + '\n',
  );
  const added = Object.entries(merged).filter(
    ([k]) => !(k in entries) || !entries[k],
  );
  if (!existsSync(envFile))
    writeFileSync(
      envFile,
      Object.entries(merged)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  else if (added.length || merged.RABBITMQ_URL !== entries.RABBITMQ_URL) {
    let content = old;
    for (const [k, v] of added)
      content = content.replace(new RegExp('^' + k + '=.*$', 'm'), '');
    if (merged.RABBITMQ_URL !== entries.RABBITMQ_URL)
      content = content.replace(
        /^RABBITMQ_URL=.*$/m,
        `RABBITMQ_URL=${JSON.stringify(merged.RABBITMQ_URL)}`,
      );
    writeFileSync(
      envFile,
      content +
        '\n# Phase 1 platform configuration\n' +
        added.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') +
        '\n',
    );
  }
  console.log(
    `Development config ready (${envFile}); existing values and database volumes preserved. Keys: .local/keys`,
  );
}
if (process.argv[1]?.endsWith('/setup.mjs')) setup();
