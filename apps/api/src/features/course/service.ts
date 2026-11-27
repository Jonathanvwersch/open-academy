import {
  restartTopic as restartTopicProgress,
  updateLearningFocus as updateCourseFocus,
} from '@academy/aesop/course/progress-commands';
import type { ContentIndex } from '@academy/aesop/course/types';
import type { EngineLearnerRepository } from '@academy/aesop/engine/repository';
import type { Database } from '../../db/client.js';
import { drizzleLearnerStore } from '../../db/learner-store.js';

export function restartTopic(input: {
  db: Database;
  userId: string;
  conceptId: string;
  content: ContentIndex;
}) {
  return restartTopicProgress(drizzleLearnerStore(input.db), input);
}

export function updateLearningFocus(input: {
  db: Database;
  repo: EngineLearnerRepository;
  userId: string;
  content: ContentIndex;
  subjectId: string | null;
  now: Date;
}) {
  return updateCourseFocus(drizzleLearnerStore(input.db), input, {
    settings: () => input.repo.settings(),
    activeSession: (now) => input.repo.activeSession(now),
    session: (id) => input.repo.session(id),
    schedulerState: (now, content) => input.repo.schedulerState(now, content),
  });
}
