import { updateActivityAndAdvance as advance } from '@open-academy/engine/planner/activity-advance';
import type { Database } from '../db/client.js';
import { drizzleLearnerStore } from '../db/learner-store.js';

export function updateActivityAndAdvance(db: Database, input: Parameters<typeof advance>[1]) {
  return advance(drizzleLearnerStore(db), input);
}
