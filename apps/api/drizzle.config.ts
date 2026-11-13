import { defineConfig } from 'drizzle-kit';
import { env } from './src/config.js';
import { repositoryPath } from './src/paths.js';
export default defineConfig({
  schema: repositoryPath('apps/api/src/db/schema.ts'),
  out: repositoryPath('apps/api/drizzle'),
  dialect: 'postgresql',
  dbCredentials: { url: env.DATABASE_URL },
});
