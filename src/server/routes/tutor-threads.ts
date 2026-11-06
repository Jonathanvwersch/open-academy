import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { instantiateExercise, isTemplate } from '../content/templates.js';
import type { ContentIndex } from '../content/types.js';
import type { Database } from '../db/client.js';
import type { LearnerRepository } from '../db/repository.js';
import {
  attempts,
  lessonProblems,
  lessonRuns,
  llmCalls,
  paperFiles,
  paperPages,
  paperProgress,
  sessionActivities,
  studySessions,
  tutorMessages,
  tutorThreads,
} from '../db/schema.js';
import { answerDisplay } from '../learning/answer-display.js';
import { buildTutorPageContent } from '../tutor/page-context.js';
import type { TutorService } from '../tutor/service.js';
import type { ApiEnv } from './api.js';
import { buildCourseWeeks } from './learn-course.js';
import { extractPaperPages } from './papers.js';

type Ctx = Context<ApiEnv>;
const bodySchema = z.object({
  question: z.string().trim().min(1).max(2000),
  conceptId: z.string().optional(),
  activityId: z.string().uuid().optional(),
  exerciseId: z.string().optional(),
  lessonProblemId: z.string().uuid().optional(),
  page: z.enum(['session', 'lesson', 'course', 'map', 'paper']).optional(),
  knowledgePointId: z.string().max(200).optional(),
  paperId: z.string().optional(),
  pageNumber: z.number().int().min(1).optional(),
  selection: z.string().trim().max(2000).optional(),
});

function formatThreadTitle(question: string): string {
  const collapsed = question.replace(/\s+/g, ' ').trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 79)}…` : collapsed;
}

function threadTitleFromMessages() {
  const firstUserMessage = sql<
    string | null
  >`(array_agg(${tutorMessages.content} order by ${tutorMessages.seq}) filter (where ${tutorMessages.role} = 'user'))[1]`;
  const normalizedContent = sql<string | null>`nullif(
    btrim(regexp_replace(${firstUserMessage}, '[[:space:]]+', ' ', 'g')),
    ''
  )`;
  return sql<string>`coalesce(
    case
      when char_length(${normalizedContent}) > 80
        then left(${normalizedContent}, 79) || '…'
      else ${normalizedContent}
    end,
    'New chat'
  )`;
}

export function registerTutorThreadRoutes(
  api: Hono<ApiEnv>,
  deps: {
    db: Database;
    content: () => Promise<ContentIndex>;
    withRepo: (context: Ctx) => LearnerRepository;
    tutor: (context: Ctx) => TutorService | null;
    requestNow: (context: Ctx) => Date;
  },
) {
  const { db } = deps;
  api.get('/tutor/threads', async (c) => {
    const rows = await db
      .select({
        id: tutorThreads.id,
        conceptId: tutorThreads.conceptId,
        title: threadTitleFromMessages(),
        updatedAt: tutorThreads.updatedAt,
        messageCount: sql<number>`count(${tutorMessages.id})::int`,
        lastMessagePreview: sql<
          string | null
        >`(array_agg(${tutorMessages.content} order by ${tutorMessages.seq}) filter (where ${tutorMessages.role} = 'user'))[1]`,
      })
      .from(tutorThreads)
      .leftJoin(tutorMessages, eq(tutorMessages.threadId, tutorThreads.id))
      .where(eq(tutorThreads.userId, c.get('userId')))
      .groupBy(tutorThreads.id)
      .orderBy(desc(tutorThreads.updatedAt), desc(tutorThreads.createdAt));
    const index = await deps.content();
    return c.json(
      rows.map((thread) => ({
        id: thread.id,
        conceptId: thread.conceptId,
        conceptTitle: thread.conceptId
          ? (index.conceptsById.get(thread.conceptId)?.title ?? thread.conceptId)
          : null,
        title: thread.title,
        updatedAt: thread.updatedAt,
        messageCount: thread.messageCount,
        lastMessagePreview: thread.lastMessagePreview?.slice(0, 140) ?? '',
      })),
    );
  });
  api.get('/tutor/threads/:id', async (c) => {
    const [thread] = await db
      .select({
        id: tutorThreads.id,
        userId: tutorThreads.userId,
        conceptId: tutorThreads.conceptId,
        title: threadTitleFromMessages(),
        createdAt: tutorThreads.createdAt,
        updatedAt: tutorThreads.updatedAt,
      })
      .from(tutorThreads)
      .leftJoin(tutorMessages, eq(tutorMessages.threadId, tutorThreads.id))
      .where(and(eq(tutorThreads.id, c.req.param('id')), eq(tutorThreads.userId, c.get('userId'))))
      .groupBy(tutorThreads.id)
      .limit(1);
    if (!thread) return c.json({ error: 'Thread not found' }, 404);
    const messages = await db
      .select({
        id: tutorMessages.id,
        role: tutorMessages.role,
        content: tutorMessages.content,
        createdAt: tutorMessages.createdAt,
      })
      .from(tutorMessages)
      .where(eq(tutorMessages.threadId, thread.id))
      .orderBy(tutorMessages.seq);
    return c.json({ thread, messages });
  });
  const send = async (c: Ctx, requestedThreadId?: string) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Invalid tutor request' }, 400);
    const input = parsed.data;
    const [thread] = requestedThreadId
      ? await db
          .select()
          .from(tutorThreads)
          .where(
            and(eq(tutorThreads.id, requestedThreadId), eq(tutorThreads.userId, c.get('userId'))),
          )
          .limit(1)
      : [];
    if (requestedThreadId && !thread) return c.json({ error: 'Thread not found' }, 404);
    const historyRows = thread
      ? await db
          .select()
          .from(tutorMessages)
          .where(eq(tutorMessages.threadId, thread.id))
          .orderBy(desc(tutorMessages.seq))
          .limit(12)
      : [];
    const history = historyRows.reverse().map((m) => ({
      role: m.role === 'assistant' ? ('tutor' as const) : ('learner' as const),
      content: m.content,
    }));
    const index = await deps.content();
    if (input.page === 'paper' && !input.paperId) {
      return c.json({ error: 'Paper id is required for paper context' }, 400);
    }
    if (input.page === 'paper' && !index.papersById.has(input.paperId ?? '')) {
      return c.json({ error: 'Paper not found' }, 404);
    }
    let exerciseId = input.exerciseId;
    let lessonProblem: typeof lessonProblems.$inferSelect | undefined;
    let currentAttempt: typeof attempts.$inferSelect | undefined;
    let activityId = input.activityId;
    let status: 'unanswered' | 'answered' | 'none' = 'none';
    if (input.lessonProblemId) {
      const [row] = await db
        .select({ problem: lessonProblems, userId: lessonRuns.userId })
        .from(lessonProblems)
        .innerJoin(lessonRuns, eq(lessonProblems.runId, lessonRuns.id))
        .where(eq(lessonProblems.id, input.lessonProblemId))
        .limit(1);
      if (!row || row.userId !== c.get('userId'))
        return c.json({ error: 'Problem not found' }, 404);
      if (input.exerciseId && input.exerciseId !== row.problem.exerciseId) {
        return c.json({ error: 'Lesson problem does not match the exercise.' }, 403);
      }
      lessonProblem = row.problem;
      exerciseId = row.problem.exerciseId;
      status = row.problem.answeredAt ? 'answered' : 'unanswered';
      const [attempt] = row.problem.attemptId
        ? await db.select().from(attempts).where(eq(attempts.id, row.problem.attemptId)).limit(1)
        : [];
      currentAttempt = attempt;
      activityId = attempt?.activityId ?? activityId;
    } else if (input.exerciseId) {
      if (!input.activityId) return c.json({ error: 'Activity required' }, 400);
      const [activity] = await db
        .select()
        .from(sessionActivities)
        .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
        .where(
          and(
            eq(sessionActivities.id, input.activityId),
            eq(studySessions.userId, c.get('userId')),
          ),
        )
        .limit(1);
      if (
        !activity ||
        !['learn', 'practice', 'remediate', 'transfer', 'teachback'].includes(
          activity.session_activities.kind,
        )
      )
        return c.json({ error: 'Tutor unavailable for this activity' }, 403);
      const [attempt] = await db
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.userId, c.get('userId')),
            eq(attempts.activityId, input.activityId),
            eq(attempts.exerciseId, input.exerciseId),
          ),
        )
        .orderBy(desc(attempts.attemptNo))
        .limit(1);
      currentAttempt = attempt;
      status = attempt ? 'answered' : 'unanswered';
    }
    let exercise = exerciseId ? index.exercisesById.get(exerciseId) : undefined;
    if (exercise && isTemplate(exercise)) {
      if (!lessonProblem)
        return c.json({ error: 'Template exercises require a lesson problem.' }, 400);
      const template = exercise;
      const concrete = instantiateExercise(template, lessonProblem.seed ?? 0).exercise;
      exercise = {
        ...concrete,
        concept: template.concept,
        contentVersion: template.contentVersion,
      };
    }
    if (exercise?.role === 'diagnostic')
      return c.json({ error: 'Tutor unavailable for this activity' }, 403);
    if (activityId) {
      const [activity] = await db
        .select({ kind: sessionActivities.kind })
        .from(sessionActivities)
        .innerJoin(studySessions, eq(sessionActivities.sessionId, studySessions.id))
        .where(and(eq(sessionActivities.id, activityId), eq(studySessions.userId, c.get('userId'))))
        .limit(1);
      if (
        !activity ||
        !['learn', 'practice', 'remediate', 'transfer', 'teachback'].includes(activity.kind)
      )
        return c.json({ error: 'Tutor unavailable for this activity' }, 403);
    }
    if (exerciseId && !exercise) return c.json({ error: 'Exercise not found' }, 404);
    const conceptId = exercise?.concept ?? input.conceptId ?? thread?.conceptId ?? null;
    const concept = conceptId ? index.conceptsById.get(conceptId) : undefined;
    const lesson = conceptId ? index.lessonsByConcept.get(conceptId) : undefined;
    const pageConceptId = exercise?.concept ?? input.conceptId ?? null;
    const courseWeeks =
      input.page === 'course'
        ? buildCourseWeeks(
            index,
            (await deps.withRepo(c).schedulerState(deps.requestNow(c))).mastery,
            await db
              .select()
              .from(lessonRuns)
              .where(eq(lessonRuns.userId, c.get('userId'))),
          )
        : undefined;
    const pageContent = buildTutorPageContent({
      page: input.page,
      index,
      conceptId: pageConceptId,
      knowledgePointId: lessonProblem?.knowledgePointId ?? input.knowledgePointId,
      courseWeeks,
      ...(input.page === 'paper'
        ? await (async () => {
            const paper = input.paperId ? index.papersById.get(input.paperId) : undefined;
            if (!paper) return { paper: undefined };
            const [progress] = await db
              .select()
              .from(paperProgress)
              .where(
                and(eq(paperProgress.paperId, paper.id), eq(paperProgress.userId, c.get('userId'))),
              )
              .limit(1);
            const [file] = await db
              .select({ bytes: paperFiles.bytes })
              .from(paperFiles)
              .where(eq(paperFiles.paperId, paper.id))
              .limit(1);
            if (file) await extractPaperPages(db, paper.id, file.bytes);
            const pageNumber = input.pageNumber ?? 1;
            const pages = await db
              .select({ page: paperPages.page, text: paperPages.text })
              .from(paperPages)
              .where(
                and(
                  eq(paperPages.paperId, paper.id),
                  sql`${paperPages.page} between ${pageNumber} and ${pageNumber + 1}`,
                ),
              )
              .orderBy(asc(paperPages.page));
            return {
              selection: input.selection,
              paper: {
                title: paper.title,
                authors: paper.authors,
                year: paper.year,
                whyThisWeek: paper.why_this_week,
                questions: paper.questions,
                notes: progress?.notes ?? {},
                summary: progress?.summary,
                feedback: progress?.summaryJudgement,
                pages,
              },
            };
          })()
        : {}),
    });
    const correct = currentAttempt?.correct ?? lessonProblem?.correct;
    const service = deps.tutor(c);
    if (!service) return c.json({ error: 'Tutor unavailable' }, 503);
    const result = await service.respond(
      {
        conceptTitle: concept?.title ?? 'General',
        objectives: concept?.objectives.map((o) => o.text) ?? [],
        lessonSummary:
          lesson?.blocks
            .filter((b) => b.kind === 'summary')
            .map((b) => b.md)
            .join('\n') ?? '',
        exercisePrompt: exercise?.prompt ?? '',
        learnerAnswer:
          status === 'answered' && currentAttempt && exercise
            ? answerDisplay(exercise, currentAttempt.answer)
            : '',
        graderVerdict:
          status !== 'answered' ? '' : correct === 1 ? 'correct' : correct === 0 ? 'incorrect' : '',
        hintLevel: 0,
        authoredHints: status === 'unanswered' ? (exercise?.hints ?? []) : [],
        solution: status === 'unanswered' ? '' : (exercise?.solution ?? ''),
        recentMistakes: [],
        question: input.question,
        mode: 'practice',
        history,
        problem_status: status,
        page: input.page ?? 'none',
        page_content: pageContent,
      },
      status === 'unanswered' ? 'nudge' : 'worked_step',
    );
    if (result.status !== 'ok' || !result.value) {
      if (result.callId) await db.delete(llmCalls).where(eq(llmCalls.id, result.callId));
      return c.json({ error: 'Tutor unavailable' }, 503);
    }
    const reply = result.value.message_md;
    const requestedNow = deps.requestNow(c);
    const [latestThread] = await db
      .select({ updatedAt: tutorThreads.updatedAt })
      .from(tutorThreads)
      .where(eq(tutorThreads.userId, c.get('userId')))
      .orderBy(desc(tutorThreads.updatedAt))
      .limit(1);
    const now = new Date(
      Math.max(requestedNow.getTime(), (latestThread?.updatedAt.getTime() ?? 0) + 1),
    );
    const tutorMessageAt = new Date(now.getTime() + 1);
    const saved = await db.transaction(async (tx) => {
      let target = thread;
      if (!target) {
        const [created] = await tx
          .insert(tutorThreads)
          .values({
            userId: c.get('userId'),
            conceptId,
            title: formatThreadTitle(input.question),
            updatedAt: now,
          })
          .returning();
        target = created;
      }
      const inserted = await tx
        .insert(tutorMessages)
        .values([
          {
            userId: c.get('userId'),
            threadId: target.id,
            activityId: activityId ?? null,
            exerciseId: exerciseId ?? null,
            lessonProblemId: input.lessonProblemId ?? null,
            role: 'user',
            content: input.question,
            createdAt: now,
          },
          {
            userId: c.get('userId'),
            threadId: target.id,
            activityId: activityId ?? null,
            exerciseId: exerciseId ?? null,
            lessonProblemId: input.lessonProblemId ?? null,
            role: 'assistant',
            content: reply,
            llmCallId: result.callId ?? null,
            createdAt: tutorMessageAt,
          },
        ])
        .returning({
          seq: tutorMessages.seq,
          id: tutorMessages.id,
          role: tutorMessages.role,
          content: tutorMessages.content,
          createdAt: tutorMessages.createdAt,
        });
      await tx
        .update(tutorThreads)
        .set({ updatedAt: tutorMessageAt })
        .where(eq(tutorThreads.id, target.id));
      return {
        thread: { ...target, updatedAt: tutorMessageAt },
        messages: inserted
          .sort((a, b) => a.seq - b.seq)
          .map(({ id, role, content, createdAt }) => ({
            id,
            role,
            content,
            createdAt,
          })),
      };
    });
    return c.json(saved);
  };
  api.post('/tutor/threads', (c) => send(c));
  api.post('/tutor/threads/:id/messages', (c) => send(c, c.req.param('id')));
}
