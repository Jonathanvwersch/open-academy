import type { Context } from 'hono';
import type { ContentIndex } from '../content/types.js';
import type { Database } from '../db/client.js';
import type { LearnerRepository } from '../db/repository.js';
import type { TutorProvider } from '../features/tutor/provider.js';
import type { TutorService } from '../features/tutor/service.js';
export type ApiEnv = { Variables: { userId: string; timeZone: string } };
export interface ApiServices {
  db: Database;
  tutorProvider: TutorProvider | null;
  content: () => Promise<ContentIndex>;
  withRepo: (context: Context<ApiEnv>) => LearnerRepository;
  tutor: (context: Context<ApiEnv>) => TutorService | null;
  requestNow: (context: Context<ApiEnv>) => Date;
}
