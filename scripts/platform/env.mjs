import { existsSync } from 'node:fs';
import { services } from './catalog.mjs';
export function loadEnv() {
  const p = process.env.PLATFORM_ENV_FILE || '.env';
  if (existsSync(p)) process.loadEnvFile(p);
  for (const name of services) {
    const k = name.toUpperCase();
    if (process.env[k + '_DB_USER'])
      process.env[k + '_DATABASE_URL'] =
        `postgresql://${process.env[k + '_DB_USER']}:${encodeURIComponent(process.env[k + '_DB_PASSWORD'])}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || process.env.POSTGRES_PORT || 5432}/${name}_db`;
  }
  if (process.env.REDIS_PASSWORD)
    process.env.REDIS_URL = `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD)}@localhost:${process.env.REDIS_PORT || 6379}`;
}
export function dbUrl(s) {
  return process.env[`${s.toUpperCase()}_DATABASE_URL`];
}
export { services };
