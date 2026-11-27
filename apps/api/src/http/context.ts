import type { ContentIndex } from '@open-academy/engine/course/types';
import type {
  EngineGenerateHint,
  EngineGrade,
  EngineHasTutorReply,
  EngineJudgeSummary,
  EngineLearner,
  EngineTutorPaper,
} from '@open-academy/engine/engine/create-engine';
import type { EngineLearnerRepository } from '@open-academy/engine/engine/repository';
import type { Context } from 'hono';
import type { Database } from '../db/client.js';
import type { users } from '../db/schema.js';
import type { TutorProvider } from '../features/tutor/provider.js';
import type { TutorService } from '../features/tutor/service.js';
export type ApiEnv = {
  Variables: { userId: string; timeZone: string; user: typeof users.$inferSelect };
};
export type LearnerOptions = {
  grade?: EngineGrade;
  hasTutorReply?: EngineHasTutorReply;
  generateHint?: EngineGenerateHint;
  tutorPaper?: EngineTutorPaper;
  judgeSummary?: EngineJudgeSummary;
};
export interface ApiServices {
  db: Database;
  tutorProvider: TutorProvider | null;
  content: () => Promise<ContentIndex>;
  withRepo: (context: Context<ApiEnv>) => EngineLearnerRepository;
  tutor: (context: Context<ApiEnv>) => TutorService | null;
  requestNow: (context: Context<ApiEnv>) => Date;
  learner: (context: Context<ApiEnv>, options?: LearnerOptions) => EngineLearner;
}
