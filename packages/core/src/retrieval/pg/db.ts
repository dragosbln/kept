import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type KeptDb = PostgresJsDatabase<typeof schema>;

export type DbHandle = {
  db: KeptDb;
  /** Ends the pool; the host calls it on shutdown, a script before exit. */
  close: () => Promise<void>;
};

export type CreateDbOptions = {
  /** Pool size; a script needs one connection, the service a few. */
  max?: number;
};

export function createDb(databaseUrl: string, options: CreateDbOptions = {}): DbHandle {
  const client = postgres(databaseUrl, {
    max: options.max ?? 5,
    // Notices (e.g. "extension already exists") are not errors; keep them off stderr.
    onnotice: () => {},
  });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}
