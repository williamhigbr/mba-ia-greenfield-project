import { registerAs } from '@nestjs/config';
import databaseConfig from './database.config';

/**
 * pg-boss runs on the same PostgreSQL instance as the app (TD-01) — no
 * dedicated broker. The connection string is derived from the shared
 * databaseConfig inputs so there is a single source of truth for the DB host
 * (the Docker Compose service name `db`, per Docker networking conventions).
 * pg-boss bootstraps its own `pgboss` schema at start() — it is NOT modeled as
 * a TypeORM entity/migration.
 */
export default registerAs('queue', () => {
  const db = databaseConfig();
  return {
    connectionString: `postgres://${db.username}:${db.password}@${db.host}:${db.port}/${db.name}`,
    schema: process.env.QUEUE_SCHEMA || 'pgboss',
  };
});
