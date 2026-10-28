import pg from 'pg';
import { loadEnv, services } from './env.mjs';
loadEnv();
const settings = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
};
const admin = new pg.Client({
  ...settings,
  database: process.env.POSTGRES_DB || 'root_db',
});
const identifier = (s) => '"' + s.replaceAll('"', '""') + '"';
const literal = (s) => "'" + s.replaceAll("'", "''") + "'";
await admin.connect();
try {
  for (const s of services) {
    const u = process.env[s.toUpperCase() + '_DB_USER'];
    const p = process.env[s.toUpperCase() + '_DB_PASSWORD'];
    if (!u || !p) throw Error(`Missing database role settings for ${s}`);
    const db = s + '_db';
    if (
      !(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [u]))
        .rowCount
    )
      await admin.query(
        `CREATE ROLE ${identifier(u)} LOGIN PASSWORD ${literal(p)}`,
      );
    const existing = await admin.query(
      'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=$1',
      [db],
    );
    if (!existing.rowCount)
      await admin.query(
        `CREATE DATABASE ${identifier(db)} OWNER ${identifier(u)}`,
      );
    // Upgrade only the six known application databases from the legacy shared-admin ownership.
    if (existing.rows[0]?.owner === settings.user && settings.user !== u) {
      await admin.query(
        `ALTER DATABASE ${identifier(db)} OWNER TO ${identifier(u)}`,
      );
      const local = new pg.Client({ ...settings, database: db });
      await local.connect();
      try {
        const tables = await local.query(
          "SELECT c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='public' AND c.relkind IN ('r','p','S') AND pg_get_userbyid(c.relowner)=$1",
          [settings.user],
        );
        for (const row of tables.rows)
          await local.query(
            `ALTER ${row.relkind === 'S' ? 'SEQUENCE' : 'TABLE'} public.${identifier(row.relname)} OWNER TO ${identifier(u)}`,
          );
        const types = await local.query(
          "SELECT t.typname FROM pg_type t JOIN pg_namespace n ON t.typnamespace=n.oid WHERE n.nspname='public' AND t.typtype='e' AND pg_get_userbyid(t.typowner)=$1",
          [settings.user],
        );
        for (const row of types.rows)
          await local.query(
            `ALTER TYPE public.${identifier(row.typname)} OWNER TO ${identifier(u)}`,
          );
      } finally {
        await local.end();
      }
    }
    await admin.query(
      `REVOKE CONNECT ON DATABASE ${identifier(db)} FROM PUBLIC`,
    );
    await admin.query(
      `GRANT CONNECT ON DATABASE ${identifier(db)} TO ${identifier(u)}`,
    );
    const local = new pg.Client({ ...settings, database: db });
    await local.connect();
    try {
      await local.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await local.query(
        `GRANT USAGE,CREATE ON SCHEMA public TO ${identifier(u)}`,
      );
    } finally {
      await local.end();
    }
    if (process.env.ENABLE_SHADOW_DATABASES === 'true') {
      const shadow = s + '_shadow';
      if (
        !(
          await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
            shadow,
          ])
        ).rowCount
      )
        await admin.query(
          `CREATE DATABASE ${identifier(shadow)} OWNER ${identifier(u)}`,
        );
      await admin.query(
        `REVOKE CONNECT ON DATABASE ${identifier(shadow)} FROM PUBLIC`,
      );
      await admin.query(
        `GRANT CONNECT ON DATABASE ${identifier(shadow)} TO ${identifier(u)}`,
      );
    }
    console.log(`Database ready: ${db}`);
  }
} finally {
  await admin.end();
}
