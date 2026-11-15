import { config } from 'dotenv';
import { repositoryPath } from './paths.js';

config({ path: repositoryPath('.env'), quiet: true });

import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url().default('postgres://academy:academy@localhost:5433/academy'),
  TEST_DATABASE_URL: z
    .string()
    .url()
    .default('postgres://academy:academy@localhost:5433/academy_test'),
  PORT: z.coerce.number().int().positive().default(3001),
  ACADEMY_PASSWORD: z.string().max(200).optional(),
  ACADEMY_DEMO: z
    .string()
    .optional()
    .transform((value) => value === '1'),
  ACADEMY_DEMO_TTL_HOURS: z.coerce.number().int().positive().default(24),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().default('gpt-6.1-sol'),
  TUTOR_DAILY_CALL_CAP: z.coerce.number().int().positive().default(200),
});

export const env = envSchema.parse(process.env);

export function productionAuth(demo: boolean, password?: string) {
  if (demo && password) {
    throw new Error('ACADEMY_DEMO and ACADEMY_PASSWORD cannot both be set.');
  }
  if (demo) return null;
  if (!password || password.length < 12) {
    throw new Error(
      'ACADEMY_PASSWORD must be set to at least 12 characters before starting production.',
    );
  }
  return { password };
}
