import { getCourse } from '@academy/aesop/course/course-reads';
import type { ContentIndex } from '@academy/aesop/course/types';
import type { EngineResult } from '@academy/aesop/engine/create-engine';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import { drizzleLearnerStore } from '../../db/learner-store.js';
import type { LearnerRepository } from '../../db/repository.js';
import type { ApiEnv, ApiServices } from '../../http/context.js';
import { restartTopic, updateLearningFocus } from './service.js';

type RouteContext = Context<ApiEnv>;
const send = (context: RouteContext, result: EngineResult) =>
  context.json(result.body, result.status);

export function registerLearnCourseRoutes(
  api: Hono<ApiEnv>,
  deps: {
    db: Database;
    content: () => Promise<ContentIndex>;
    withRepo: (context: RouteContext) => LearnerRepository;
    requestNow: (context: RouteContext) => Date;
    learner: ApiServices['learner'];
  },
) {
  async function courseUseCase(context: RouteContext, content: ContentIndex) {
    const timeZone = context.get('timeZone');
    return {
      store: drizzleLearnerStore(deps.db, { schedulerTimezone: timeZone }),
      input: {
        userId: context.get('userId'),
        content,
        timeZone,
        settings: (await deps.withRepo(context).settings()) ?? null,
        now: () => deps.requestNow(context),
        enableFsrsFuzz: process.env.NODE_ENV !== 'test',
      },
    };
  }

  api.get('/learn', async (context) => {
    return send(context, await deps.learner(context).learn());
  });

  api.get('/courses', async (context) => {
    return send(context, await deps.learner(context).courseCatalog());
  });

  api.put('/focus', async (context) => {
    const body = z
      .object({ subjectId: z.string().nullable() })
      .strict()
      .safeParse(await context.req.json().catch(() => null));
    if (!body.success) return context.json({ error: 'Invalid focus subject' }, 400);
    const index = await deps.content();
    const subjectId = body.data.subjectId;
    if (
      subjectId !== null &&
      !index.curriculum?.subjects?.some((subject) => subject.id === subjectId)
    ) {
      return context.json({ error: 'Unknown focus subject' }, 400);
    }

    await updateLearningFocus({
      db: deps.db,
      repo: deps.withRepo(context),
      userId: context.get('userId'),
      content: index,
      subjectId,
      now: deps.requestNow(context),
    });
    return context.json({ focusSubjectId: subjectId });
  });

  api.get('/courses/:id', async (context) => {
    return send(context, await deps.learner(context).course({ courseId: context.req.param('id') }));
  });

  api.get('/course', async (context) => {
    const { store, input } = await courseUseCase(context, await deps.content());
    return context.json(await getCourse(store, input, context.req.query('course')));
  });

  api.put('/course/active', async (context) => {
    return send(
      context,
      await deps.learner(context).setActiveCourse({
        body: await context.req.json().catch(() => null),
      }),
    );
  });

  api.post('/concepts/:id/restart', async (context) => {
    const index = await deps.content();
    const conceptId = context.req.param('id');
    if (!index.conceptsById.has(conceptId)) {
      return context.json({ error: 'Concept not found' }, 404);
    }
    await restartTopic({ db: deps.db, userId: context.get('userId'), conceptId, content: index });
    return context.json({ conceptId });
  });

  api.put('/courses/:id/enrollment', async (context) => {
    const index = await deps.content();
    const courseId = context.req.param('id');
    if (!index.coursesById.has(courseId)) return context.json({ error: 'Course not found' }, 404);
    const body = (await context.req.json().catch(() => null)) as { status?: unknown } | null;
    if (body?.status !== 'active' && body?.status !== 'paused') {
      return context.json({ error: 'Invalid enrollment status' }, 400);
    }
    const repo = deps.withRepo(context);
    const enrollment = await repo.courseEnrollment(courseId);
    if (!enrollment) {
      return context.json(
        { error: body.status === 'active' ? 'Start this course first' : 'Course is not active' },
        409,
      );
    }
    await repo.setCourseEnrollmentStatus(courseId, body.status);
    return context.json({ id: courseId, status: body.status });
  });

  api.post('/courses/:id/start', async (context) => {
    return send(
      context,
      await deps.learner(context).startCourse({
        courseId: context.req.param('id'),
        body: await context.req.json().catch(() => null),
      }),
    );
  });

  api.post('/course/start', async (context) => {
    return send(
      context,
      await deps.learner(context).startCourse({
        body: await context.req.json().catch(() => null),
      }),
    );
  });
}
