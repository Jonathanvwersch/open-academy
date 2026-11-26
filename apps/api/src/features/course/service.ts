import {
  replanSessionActivities as replanCourseSession,
  restartTopic as restartTopicProgress,
  updateLearningFocus as updateCourseFocus,
} from '@academy/aesop/course/progress-commands';
import type { ContentIndex } from '@academy/aesop/course/types';
import type { SchedulerState } from '@academy/aesop/planner/scheduler';
import type { Database } from '../../db/client.js';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import type { LearnerRepository } from '../../db/repository.js';

export function restartTopic(input: {
  db: Database;
  userId: string;
  conceptId: string;
  content: ContentIndex;
}) {
  return restartTopicProgress(drizzleLearnerStore(input.db), input);
}

export async function replanSessionActivities(input: {
  db: Database;
  repo: LearnerRepository;
  userId: string;
  content: ContentIndex;
  now: Date;
  session: NonNullable<Awaited<ReturnType<LearnerRepository['session']>>>;
  skipActivityIds?: readonly string[];
  activatePlannedActivityId?: string;
  schedulerState?: SchedulerState;
}) {
  return replanCourseSession(drizzleLearnerStore(input.db), {
    ...input,
    schedulerState:
      input.schedulerState ?? (await input.repo.schedulerState(input.now, input.content)),
  });
}

export function updateLearningFocus(input: {
  db: Database;
  repo: LearnerRepository;
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
