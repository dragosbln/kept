// drizzle-kit: `pnpm db:generate` diffs schema.ts against packages/core/drizzle
// and writes the next SQL migration there; `pnpm db:migrate` applies them.
import { defineConfig } from 'drizzle-kit';

const url = process.env['DATABASE_URL'];

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/retrieval/pg/schema.ts',
  out: './drizzle',
  ...(url ? { dbCredentials: { url } } : {}),
});
