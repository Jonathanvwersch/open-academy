import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDb(url: string) {
  const client = process.env.VERCEL ? postgres(url, { max: 1, prepare: false }) : postgres(url);
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;
