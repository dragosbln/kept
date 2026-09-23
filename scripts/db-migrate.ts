// Applies packages/core/drizzle to DATABASE_URL. Idempotent: a current
// database is a no-op. Run once after `pnpm stack:up`, and after pulling a
// change that adds a migration.
//
//   pnpm db:migrate

import { migrateDb } from '../packages/core/src/index.ts';

const url = process.env['DATABASE_URL'];
if (!url) {
  throw new Error('DATABASE_URL is not set; copy .env.example to .env and run `pnpm stack:up`');
}

await migrateDb(url);
console.log('migrations: database is current');
