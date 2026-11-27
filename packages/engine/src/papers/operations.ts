import { z } from 'zod';
import type { IndexedPaper } from '../course/types.js';
import type { EngineRequest, EngineResult } from '../engine/types.js';
import { respond } from '../engine/types.js';
import { activeCourseFor } from '../graph/prerequisites.js';
import { updateActivityAndAdvance } from '../planner/activity-advance.js';
import type { Activity } from '../store/session-store.js';

function paperFor(request: EngineRequest, id: string): IndexedPaper | undefined {
  return request.content.papersById.get(id);
}

export async function papers(request: EngineRequest): Promise<EngineResult> {
  const progress = new Map(
    (await request.store.listPaperProgress(request.userId)).map((row) => [row.paperId, row]),
  );
  const studyCourseIds = await request.repo.studyCourseIds(request.content);
  const user = await request.repo.user();
  const courseIds = studyCourseIds.length ? studyCourseIds : [user?.activeCourseId ?? ''];
  const seen = new Set<string>();
  const units = courseIds.flatMap((courseId) => {
    const course = activeCourseFor(request.content, courseId);
    return (course?.units ?? []).map((unit, unitIndex) => ({
      courseId: course?.id ?? courseId,
      courseTitle: course?.title ?? '',
      unit: unitIndex + 1,
      title: unit.title,
      papers: (unit.papers ?? []).flatMap((paperId) => {
        if (seen.has(paperId)) return [];
        seen.add(paperId);
        const paper = request.content.papersById.get(paperId);
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
  return respond({ units });
}

export async function paper(request: EngineRequest, id: string): Promise<EngineResult> {
  const content = paperFor(request, id);
  if (!content) return respond({ error: 'Paper not found' }, 404);
  const progress = (await request.store.getPaperProgress(request.userId, content.id)) ?? null;
  const safePaper = {
    ...content,
    summary: {
      prompt: content.summary.prompt,
      ...(progress?.completedAt ? { rubric: content.summary.rubric } : {}),
    },
  };
  const originalUrl =
    'arxiv' in content.source
      ? `https://arxiv.org/abs/${content.source.arxiv.replace(/v\d+$/, '')}`
      : content.source.url;
  return respond({ paper: safePaper, progress, originalUrl });
}

export async function savePaperProgress(
  request: EngineRequest,
  id: string,
  input: unknown,
): Promise<EngineResult> {
  const content = paperFor(request, id);
  if (!content) return respond({ error: 'Paper not found' }, 404);
  const body = z
    .object({
      lastPage: z.number().int().min(1).optional(),
      notes: z.record(z.string(), z.string().max(4000)).optional(),
    })
    .strict()
    .safeParse(input);
  if (!body.success) return respond({ error: 'Invalid paper progress' }, 400);
  const allowed = new Set(content.questions.map((question) => question.id));
  if (Object.keys(body.data.notes ?? {}).some((questionId) => !allowed.has(questionId))) {
    return respond({ error: 'Unknown question id in notes' }, 400);
  }
  const saved = await request.store.savePaperProgress(request.userId, {
    paperId: content.id,
    ...(body.data.lastPage !== undefined ? { lastPage: body.data.lastPage } : {}),
    ...(body.data.notes !== undefined ? { notes: body.data.notes } : {}),
    updatedAt: request.now(),
  });
  return respond(saved);
}

export async function submitPaperSummary(
  request: EngineRequest,
  id: string,
  input: unknown,
): Promise<EngineResult> {
  const content = paperFor(request, id);
  if (!content) return respond({ error: 'Paper not found' }, 404);
  const body = z
    .object({
      summary: z.string().trim().min(1).max(4000),
      activityId: z.string().uuid().optional(),
    })
    .strict()
    .safeParse(input);
  if (!body.success) return respond({ error: 'Invalid paper summary' }, 400);

  let activity: Activity | undefined;
  let activities: Activity[] = [];
  if (body.data.activityId) {
    [activity] = await request.store.listActivities(request.userId, {
      ids: [body.data.activityId],
    });
    if (activity?.kind !== 'paper') {
      return respond({ error: 'Paper activity not found' }, 404);
    }
    activities = await request.store.listActivities(request.userId, {
      sessionIds: [activity.sessionId],
    });
  }

  const now = request.now();
  const judged = request.judgeSummary
    ? await request.judgeSummary({
        question: content.summary.prompt,
        rubric: content.summary.rubric,
        exemplar: content.summary.exemplar,
        answer: body.data.summary,
      })
    : { reason: 'Tutor grading is disabled.' };
  const judgement = 'judgement' in judged ? judged.judgement : null;
  const reason = 'reason' in judged ? judged.reason : undefined;
  await request.store.transaction(async (store) => {
    await store.savePaperProgress(request.userId, {
      paperId: content.id,
      summary: body.data.summary,
      summaryJudgement: judgement,
      completedAt: now,
      updatedAt: now,
    });
    if (activity) {
      await updateActivityAndAdvance(store, {
        activityId: activity.id,
        completed: true,
        now,
        session: { activities },
        userId: request.userId,
        timeZone: request.timeZone,
      });
    }
  });
  return respond({
    judgement,
    completedAt: now.toISOString(),
    rubric: content.summary.rubric,
    ...(reason ? { reason } : {}),
  });
}
