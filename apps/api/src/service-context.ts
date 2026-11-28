import type { ContentIndex } from '@open-academy/engine';
import type { EngineLearnerRepository } from '@open-academy/engine/store';
import type { Database } from './db/client.js';
import type { TutorProvider } from './features/tutor/provider.js';
import type { TutorService } from './features/tutor/service.js';
export interface FeatureServices {
  db: Database;
  content: () => Promise<ContentIndex>;
  tutorProvider: TutorProvider | null;
}
export interface FeatureRequest {
  userId: string;
  timeZone: string;
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  repo: EngineLearnerRepository;
  tutor: TutorService | null;
  now: () => Date;
}
type ResultStatus = 200 | 201 | 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503;
export const serviceResult = <T>(body: T, status: ResultStatus = 200) => ({ body, status });
