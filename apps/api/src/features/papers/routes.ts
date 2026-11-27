import { createHash } from 'node:crypto';
import type { ContentIndex, IndexedPaper } from '@open-academy/engine/course/types';
import type { EngineLearnerRepository } from '@open-academy/engine/engine/repository';
import { activeCourseFor } from '@open-academy/engine/graph/prerequisites';
import { and, eq, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  paperFiles,
  paperProgress,
  sessionActivities,
  studySessions,
  users,
} from '../../db/schema.js';
import type { ApiEnv } from '../../http/context.js';
import { updateActivityAndAdvance } from '../../learning/activity-completion.js';
import type { TutorService } from '../tutor/service.js';
import type { PaperFetcher } from './fetcher.js';
import { defaultPaperFetcher } from './fetcher.js';

type PaperContext = Context<ApiEnv>;

const pdfLoads = new Map<string, Promise<Buffer>>();

export function registerPaperRoutes(
  api: Hono<ApiEnv>,
  deps: {
    db: Database;
    content: () => Promise<ContentIndex>;
    withRepo: (context: PaperContext) => EngineLearnerRepository;
    tutor: (context: PaperContext) => TutorService | null;
    paperFetcher?: PaperFetcher;
    requestNow: (context: PaperContext) => Date;
  },
) {
  const fetcher = deps.paperFetcher ?? defaultPaperFetcher();
  const loadPdf = async (paper: IndexedPaper) => {
    const [cached] = await deps.db
      .select({ bytes: paperFiles.bytes })
      .from(paperFiles)
      .where(eq(paperFiles.paperId, paper.id))
      .limit(1);
    if (cached) return Buffer.from(cached.bytes);
    const existing = pdfLoads.get(paper.id);
    if (existing) return existing;
    const pending = (async () => {
      const bytes = Buffer.from(await fetcher.fetch(paper));
      if (bytes.length > 40 * 1024 * 1024 || bytes.subarray(0, 4).toString() !== '%PDF') {
        throw new Error('Fetched file is not a valid PDF under 40 MB');
      }
      await deps.db
        .insert(paperFiles)
        .values({
          paperId: paper.id,
          bytes,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          fetchedAt: new Date(),
        })
        .onConflictDoNothing();
      return bytes;
    })();
    pdfLoads.set(paper.id, pending);
    try {
      return await pending;
    } finally {
      pdfLoads.delete(paper.id);
    }
  };
  const paperFor = async (id: string) => (await deps.content()).papersById.get(id);

  api.get('/papers', async (c) => {
    const index = await deps.content();
    const rows = await deps.db
      .select()
      .from(paperProgress)
      .where(eq(paperProgress.userId, c.get('userId')));
    const progress = new Map(rows.map((row) => [row.paperId, row]));
    const studyCourseIds = await deps.withRepo(c).studyCourseIds(index);
    const [user] = await deps.db
      .select({ activeCourseId: users.activeCourseId })
      .from(users)
      .where(eq(users.id, c.get('userId')))
      .limit(1);
    const courseIds = studyCourseIds.length ? studyCourseIds : [user?.activeCourseId ?? ''];
    const seen = new Set<string>();
    const grouped = courseIds.flatMap((courseId) => {
      const course = activeCourseFor(index, courseId);
      return (course?.units ?? []).map((unit, unitIndex) => ({
        courseId: course?.id ?? courseId,
        courseTitle: course?.title ?? '',
        unit: unitIndex + 1,
        title: unit.title,
        papers: (unit.papers ?? []).flatMap((paperId) => {
          if (seen.has(paperId)) return [];
          seen.add(paperId);
          const paper = index.papersById.get(paperId);
          if (!paper) return [];
          const row = progress.get(paper.id);
          return [
            {
              id: paper.id,
              title: paper.title,
              authors: paper.authors,
              year: paper.year,
              est_minutes: paper.est_minutes,
              status: !row ? 'not_started' : row.completedAt ? 'completed' : 'reading',
            },
          ];
        }),
      }));
    });
    return c.json({ units: grouped });
  });

  api.get('/papers/:id', async (c) => {
    const paper = await paperFor(c.req.param('id'));
    if (!paper) return c.json({ error: 'Paper not found' }, 404);
    const [progress] = await deps.db
      .select()
      .from(paperProgress)
      .where(and(eq(paperProgress.paperId, paper.id), eq(paperProgress.userId, c.get('userId'))))
      .limit(1);
    const safePaper = {
      ...paper,
      summary: {
        prompt: paper.summary.prompt,
        ...(progress?.completedAt ? { rubric: paper.summary.rubric } : {}),
      },
    };
    const originalUrl =
      'arxiv' in paper.source
        ? `https://arxiv.org/abs/${paper.source.arxiv.replace(/v\d+$/, '')}`
        : paper.source.url;
    return c.json({ paper: safePaper, progress: progress ?? null, originalUrl });
  });

  api.put('/papers/:id/progress', async (c) => {
    const paper = await paperFor(c.req.param('id'));
    if (!paper) return c.json({ error: 'Paper not found' }, 404);
    const body = z
      .object({
        lastPage: z.number().int().min(1).optional(),
        notes: z.record(z.string(), z.string().max(4000)).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Invalid paper progress' }, 400);
    const allowed = new Set(paper.questions.map((question) => question.id));
    if (Object.keys(body.data.notes ?? {}).some((id) => !allowed.has(id))) {
      return c.json({ error: 'Unknown question id in notes' }, 400);
    }
    const [existing] = await deps.db
      .select()
      .from(paperProgress)
      .where(and(eq(paperProgress.userId, c.get('userId')), eq(paperProgress.paperId, paper.id)))
      .limit(1);
    const [saved] = await deps.db
      .insert(paperProgress)
      .values({
        userId: c.get('userId'),
        paperId: paper.id,
        lastPage: body.data.lastPage ?? existing?.lastPage ?? 1,
        notes: { ...(existing?.notes ?? {}), ...(body.data.notes ?? {}) },
        summary: existing?.summary ?? null,
        summaryJudgement: existing?.summaryJudgement ?? null,
        completedAt: existing?.completedAt ?? null,
        updatedAt: deps.requestNow(c),
      })
      .onConflictDoUpdate({
        target: [paperProgress.userId, paperProgress.paperId],
        set: {
          ...(body.data.lastPage !== undefined ? { lastPage: body.data.lastPage } : {}),
          ...(body.data.notes
            ? { notes: sql`${paperProgress.notes} || ${JSON.stringify(body.data.notes)}::jsonb` }
            : {}),
          updatedAt: deps.requestNow(c),
        },
      })
      .returning();
    return c.json(saved);
  });

  api.post('/papers/:id/summary', async (c) => {
    const paper = await paperFor(c.req.param('id'));
    if (!paper) return c.json({ error: 'Paper not found' }, 404);
    const body = z
      .object({
        summary: z.string().trim().min(1).max(4000),
        activityId: z.string().uuid().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: 'Invalid paper summary' }, 400);
    const now = deps.requestNow(c);
    let activity: { id: string; sessionId: string } | undefined;
    if (body.data.activityId) {
      const [found] = await deps.db
        .select({ id: sessionActivities.id, sessionId: sessionActivities.sessionId })
        .from(sessionActivities)
        .innerJoin(studySessions, eq(studySessions.id, sessionActivities.sessionId))
        .where(
          and(
            eq(sessionActivities.id, body.data.activityId),
            eq(sessionActivities.kind, 'paper'),
            eq(studySessions.userId, c.get('userId')),
          ),
        )
        .limit(1);
      if (!found) return c.json({ error: 'Paper activity not found' }, 404);
      activity = found;
    }
    let judgement: unknown = null;
    let reason: string | undefined;
    const service = deps.tutor(c);
    if (!service) {
      reason = 'Tutor grading is disabled.';
    } else {
      try {
        const result = await service.gradeExplanation({
          question: paper.summary.prompt,
          rubric: paper.summary.rubric,
          exemplar: paper.summary.exemplar,
          answer: body.data.summary,
        });
        if (result.status === 'ok' && result.value) judgement = result.value;
        else
          reason =
            result.status === 'budget_exceeded'
              ? 'Tutor grading limit reached.'
              : 'Tutor grading failed.';
      } catch {
        reason = 'Tutor grading failed.';
      }
    }
    await deps.db
      .insert(paperProgress)
      .values({
        userId: c.get('userId'),
        paperId: paper.id,
        summary: body.data.summary,
        summaryJudgement: judgement as never,
        completedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [paperProgress.userId, paperProgress.paperId],
        set: {
          summary: body.data.summary,
          summaryJudgement: judgement as never,
          completedAt: now,
          updatedAt: now,
        },
      });
    if (activity) {
      const activities = await deps.db
        .select()
        .from(sessionActivities)
        .where(eq(sessionActivities.sessionId, activity.sessionId));
      await updateActivityAndAdvance(deps.db, {
        activityId: activity.id,
        completed: true,
        now,
        session: { activities },
        userId: c.get('userId'),
        timeZone: c.get('timeZone'),
      });
    }
    return c.json({
      judgement,
      completedAt: now.toISOString(),
      rubric: paper.summary.rubric,
      ...(reason ? { reason } : {}),
    });
  });

  api.get('/papers/:id/pdf', async (c) => {
    const paper = await paperFor(c.req.param('id'));
    if (!paper) return c.json({ error: 'Paper not found' }, 404);
    try {
      const bytes = await loadPdf(paper);
      return c.body(Uint8Array.from(bytes), 200, {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'private, max-age=86400',
      });
    } catch {
      return c.json({ error: 'Paper PDF is unavailable.' }, 502);
    }
  });
}
