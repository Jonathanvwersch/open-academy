import {
  restartTopic as restartTopicProgress,
  updateLearningFocus as updateCourseFocus,
} from '@open-academy/engine/course/progress-commands';
import type { ContentIndex } from '@open-academy/engine/course/types';
import type { EngineLearnerRepository } from '@open-academy/engine/engine/repository';
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
