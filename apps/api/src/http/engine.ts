import type { ContentIndex } from '@open-academy/engine/course/types';
import { createEngine } from '@open-academy/engine/engine/create-engine';
import type { Database } from '../db/client.js';
import { drizzleLearnerStore } from '../db/learner-store.js';
import { fsrsFuzzEnabled } from '../learning/fsrs-fuzz.js';

export function createApiEngine(input: {
  db: Database;
  content: () => Promise<ContentIndex>;
  tutorEnabled: boolean;
}) {
  return createEngine({
    content: input.content,
    store: drizzleLearnerStore(input.db),
    fsrsFuzz: fsrsFuzzEnabled(),
    tutorEnabled: input.tutorEnabled,
  });
}
