import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './db.js';

/** packages/core/drizzle: the SQL drizzle-kit generated from schema.ts, applied in order, once each. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/', import.meta.url));

/** Applies pending migrations; a no-op when the database is current. Safe to call at every boot. */
export async function migrateDb(databaseUrl: string): Promise<void> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await handle.close();
  }
}
