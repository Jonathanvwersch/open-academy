import { asc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { env } from '../config.js';
import type { ContentIndex } from '../content/types.js';
import type { Database } from '../db/client.js';
import { LearnerRepository } from '../db/repository.js';
import { users, xpEvents } from '../db/schema.js';
import { registerCourseRoutes } from '../features/course/overview-routes.js';
import { registerLearnCourseRoutes } from '../features/course/routes.js';
import { registerExercisesRoutes } from '../features/exercises/routes.js';
import { registerLessonsRoutes } from '../features/lessons/review-routes.js';
import { registerLessonRunRoutes } from '../features/lessons/run-routes.js';
import type { PaperFetcher } from '../features/papers/fetcher.js';
import { registerPaperRoutes } from '../features/papers/routes.js';
import { registerPlacementRoutes } from '../features/placement/routes.js';
import { registerProgressRoutes } from '../features/progress/routes.js';
import { registerProjectsRoutes } from '../features/projects/routes.js';
import { registerReviewsRoutes } from '../features/reviews/routes.js';
import { registerSessionsRoutes } from '../features/sessions/routes.js';
import { registerSettingsRoutes } from '../features/settings/routes.js';
import {
  createTutorProvider,
  E2ETutorProvider,
  type TutorProvider,
} from '../features/tutor/provider.js';
import { registerTutorThreadRoutes } from '../features/tutor/routes.js';
import { TutorService } from '../features/tutor/service.js';
import { applyMastery } from '../learning/mastery-service.js';
import { localDateKey } from '../learning/xp.js';
import type { ApiEnv } from './context.js';
import { isValidTimeZone, requestNow } from './request-context.js';
export function createApiRoutes(deps: {
  db: Database;
  content?: ContentIndex;
  tutorProvider?: TutorProvider | null;
  paperFetcher?: PaperFetcher;
}) {
  const api = new Hono<ApiEnv>();
  let contentPromise: Promise<ContentIndex> | undefined;
  const content = () => {
    contentPromise ??= deps.content
      ? Promise.resolve(deps.content)
      : import('../content/load.js').then(({ loadContent }) => loadContent());
    return contentPromise;
  };
  const db = deps.db;
  const tutorProvider =
    deps.tutorProvider === undefined
      ? process.env.ACADEMY_E2E === '1'
        ? new E2ETutorProvider()
        : createTutorProvider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL })
      : deps.tutorProvider;
  api.use('*', async (context, next) => {
    const [user] = await db
      .select()
      .from(users)
      .orderBy(asc(users.createdAt), asc(users.id))
      .limit(1);
    if (!user) {
      return context.json({ error: 'Seed the default learner before using the API.' }, 503);
    }
    const requestedTimeZone = context.req.header('X-Time-Zone');
    const timeZone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : user.timezone;
    if (timeZone !== user.timezone) {
      await db.transaction(async (tx) => {
        await tx.update(users).set({ timezone: timeZone }).where(eq(users.id, user.id));
        const events = await tx
          .select({ id: xpEvents.id, earnedAt: xpEvents.earnedAt })
          .from(xpEvents)
          .where(eq(xpEvents.userId, user.id));
        for (const event of events) {
          await tx
            .update(xpEvents)
            .set({ localDate: localDateKey(event.earnedAt, timeZone) })
            .where(eq(xpEvents.id, event.id));
        }
      });
    }
    context.set('userId', user.id);
    context.set('timeZone', timeZone);
    context.set('user', { ...user, timezone: timeZone });
    await next();
  });
  const withRepo = (context: Context<ApiEnv>) =>
    new LearnerRepository(db, context.get('userId'), context.get('user'));
  const tutor = (context: Context<ApiEnv>) =>
    tutorProvider &&
    new TutorService(
      db,
      tutorProvider,
      context.get('userId'),
      env.TUTOR_DAILY_CALL_CAP,
      context.get('timeZone'),
    );
  registerLessonRunRoutes(api, {
    db,
    content,
    withRepo,
    requestNow,
    applyMastery,
  });
  registerLearnCourseRoutes(api, { db, content, withRepo, requestNow });
  registerTutorThreadRoutes(api, { db, content, withRepo, tutor, requestNow });
  registerPaperRoutes(api, {
    db,
    content,
    withRepo,
    tutor,
    paperFetcher: deps.paperFetcher,
    requestNow,
  });
  registerSessionsRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  registerExercisesRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  registerLessonsRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  registerPlacementRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  registerCourseRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  registerSettingsRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  registerProjectsRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  registerProgressRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  registerReviewsRoutes(api, { db, content, withRepo, tutor, requestNow, tutorProvider });
  return api;
}
