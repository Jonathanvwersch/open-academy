import { onScreenOptions } from '@academy/shared/shuffle';
import { TUTOR_QUESTION_MAX_LENGTH, tutorQuestionTooLongMessage } from '@academy/shared/tutor';
import { tutorLessonStages } from '@open-academy/engine/api/tutor';
import { buildCoursePayload } from '@open-academy/engine/course/course-payload';
import { serializedOptionOrder } from '@open-academy/engine/course/serialize';
import { instantiateExercise, isTemplate } from '@open-academy/engine/course/templates';
import type { ContentIndex } from '@open-academy/engine/course/types';
import type { EngineLearnerRepository } from '@open-academy/engine/engine/repository';
import { courseFoundationIds } from '@open-academy/engine/graph/prerequisites';
import { attemptAllowsRetry } from '@open-academy/engine/memory/retry';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { Database } from '../../db/client.js';
import {
  attempts,
  lessonProblems,
  lessonRuns,
  paperFiles,
  paperPages,
  paperProgress,
  sessionActivities,
  studySessions,
  tutorMessages,
  tutorThreads,
  users,
} from '../../db/schema.js';
import type { ApiEnv } from '../../http/context.js';
import { extractPaperPages } from '../papers/service.js';
import {
  formatGraderFeedback,
  graderVerdictFor,
  tutorAnswerFor,
  tutorAnswerKeyFor,
  tutorSolutionFor,
} from './feedback-context.js';
import { buildTutorPageContent } from './page-context.js';
import { type TutorService, tutorFailureDetails } from './service.js';

type Ctx = Context<ApiEnv>;
const optionalNullable = <T extends z.ZodTypeAny>(schema: T) =>
  schema.nullish().transform((value) => value ?? undefined);

export const tutorThreadBodySchema = z.object({
  question: z.string().trim().min(1).max(TUTOR_QUESTION_MAX_LENGTH),
  clientMessageId: z.string().uuid().optional(),
  earlier: z
    .array(
      z.object({
        clientMessageId: z.string().uuid(),
        question: z.string().trim().min(1).max(TUTOR_QUESTION_MAX_LENGTH),
      }),
    )
    .max(5)
    .optional(),
  threadId: optionalNullable(z.string().uuid()),
  conceptId: optionalNullable(z.string()),
  activityId: optionalNullable(z.string().uuid()),
  exerciseId: optionalNullable(z.string()),
  questionLabel: z.string().trim().max(60).optional(),
  lessonStage: optionalNullable(z.enum(tutorLessonStages)),
  lessonProblemId: optionalNullable(z.string().uuid()),
  page: optionalNullable(z.enum(['session', 'lesson', 'course', 'map', 'paper'])),
  knowledgePointId: optionalNullable(z.string().max(200)),
  paperId: optionalNullable(z.string()),
  pageNumber: optionalNullable(z.number().int().min(1)),
  selection: optionalNullable(z.string().trim().max(2000)),
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
    withRepo: (context: Ctx) => EngineLearnerRepository;
    tutor: (context: Ctx) => TutorService | null;
    requestNow: (context: Ctx) => Date;
  },
) {
  const { db } = deps;
  api.get('/tutor/status', (context) =>
    context.json({ tutorEnabled: deps.tutor(context) !== null }),
  );
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
    if (!z.string().uuid().safeParse(c.req.param('id')).success)
      return c.json({ error: 'Thread not found' }, 404);
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
        clientId: tutorMessages.clientId,
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
    if (requestedThreadId && !z.string().uuid().safeParse(requestedThreadId).success)
      return c.json({ error: 'Thread not found' }, 404);
    const body: unknown = await c.req.json().catch(() => ({}));
    const parsed = tutorThreadBodySchema.safeParse(body);
    if (!parsed.success) {
      const question = (body as { question?: unknown } | null)?.question;
      const tooLong =
        typeof question === 'string' && question.trim().length > TUTOR_QUESTION_MAX_LENGTH;
      return c.json(
        { error: tooLong ? tutorQuestionTooLongMessage() : 'Invalid tutor request' },
        400,
      );
    }
    const input = parsed.data;
    const targetThreadId = requestedThreadId ?? input.threadId;
    const [thread] = targetThreadId
      ? await db
          .select()
          .from(tutorThreads)
          .where(and(eq(tutorThreads.id, targetThreadId), eq(tutorThreads.userId, c.get('userId'))))
          .limit(1)
      : [];
    if (requestedThreadId && !thread) return c.json({ error: 'Thread not found' }, 404);
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
    let status: 'unanswered' | 'retrying' | 'answered' | 'none' = 'none';
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
      status = !attempt ? 'unanswered' : attemptAllowsRetry(attempt) ? 'retrying' : 'answered';
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
    if (exercise?.role === 'recall')
      return c.json({ error: 'Review recall exercises are not available to the tutor.' }, 403);
    if (exercise?.role === 'diagnostic')
      return c.json({ error: 'Placement check exercises do not allow tutor answers.' }, 403);
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
    const courseState =
      input.page === 'course'
        ? await deps.withRepo(c).schedulerState(deps.requestNow(c), index)
        : undefined;
    const matchingCourseIds =
      input.page === 'paper' && input.paperId
        ? index.courses
            .filter((candidate) =>
              candidate.units.some((unit) => unit.papers?.includes(input.paperId ?? '')),
            )
            .map((candidate) => candidate.id)
        : pageConceptId
          ? index.courses
              .filter((candidate) =>
                candidate.units.some((unit) => unit.concepts.includes(pageConceptId)),
              )
              .map((candidate) => candidate.id)
          : [];
    const contextCourseId = courseState
      ? (courseState.studyCourseIds.find(
          (courseId) =>
            matchingCourseIds.includes(courseId) ||
            (pageConceptId && courseFoundationIds(index, courseId).has(pageConceptId)),
        ) ??
        matchingCourseIds[0] ??
        courseState.studyCourseIds[0] ??
        courseState.activeCourseId)
      : undefined;
    const courseUnits = courseState
      ? buildCoursePayload(
          index,
          contextCourseId,
          courseState.mastery,
          await db
            .select()
            .from(lessonRuns)
            .where(eq(lessonRuns.userId, c.get('userId'))),
        ).units
      : undefined;
    const pageContent = buildTutorPageContent({
      page: input.page,
      index,
      conceptId: pageConceptId,
      knowledgePointId: lessonProblem?.knowledgePointId ?? input.knowledgePointId,
      lessonStage: input.lessonStage,
      exerciseId,
      exercisePrompt: exercise?.prompt,
      questionLabel: input.questionLabel,
      courseUnits,
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
    const optionTexts =
      exercise?.type === 'mc'
        ? onScreenOptions(
            serializedOptionOrder(exercise.options, c.get('userId'), exercise.id),
            exercise.id,
          )
        : exercise?.type === 'debug'
          ? onScreenOptions(exercise.fix_options, exercise.id)
          : [];
    const service = deps.tutor(c);
    if (!service) return c.json({ error: 'Tutor unavailable' }, 503);

    const signal = c.req.raw.signal;
    const request = await db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, c.get('userId')))
        .for('update');
      const [latestThread] = await tx
        .select({ updatedAt: tutorThreads.updatedAt })
        .from(tutorThreads)
        .where(eq(tutorThreads.userId, c.get('userId')))
        .orderBy(desc(tutorThreads.updatedAt))
        .limit(1);
      let target = targetThreadId
        ? (
            await tx
              .select()
              .from(tutorThreads)
              .where(
                and(eq(tutorThreads.id, targetThreadId), eq(tutorThreads.userId, c.get('userId'))),
              )
              .for('update')
              .limit(1)
          )[0]
        : thread;
      const createdThread = !target;
      const previousUpdatedAt = target?.updatedAt ?? null;
      let lastMessageAt = Math.max(
        target?.updatedAt.getTime() ?? 0,
        latestThread?.updatedAt.getTime() ?? 0,
      );
      const nextMessageAt = () => {
        lastMessageAt = Math.max(deps.requestNow(c).getTime(), lastMessageAt + 1);
        return new Date(lastMessageAt);
      };
      if (!target) {
        const threadCreatedAt = nextMessageAt();
        const [created] = await tx
          .insert(tutorThreads)
          .values({
            ...(targetThreadId ? { id: targetThreadId } : {}),
            userId: c.get('userId'),
            conceptId,
            title: formatThreadTitle(input.question),
            updatedAt: threadCreatedAt,
          })
          .returning();
        if (!created) throw new Error('Tutor thread was not created');
        target = created;
      }
      let lastInsertedAt: Date | null = null;
      for (const earlier of input.earlier ?? []) {
        const createdAt = nextMessageAt();
        const [insertedEarlier] = await tx
          .insert(tutorMessages)
          .values({
            userId: c.get('userId'),
            threadId: target.id,
            clientId: earlier.clientMessageId,
            activityId: activityId ?? null,
            exerciseId: exerciseId ?? null,
            lessonProblemId: input.lessonProblemId ?? null,
            role: 'user',
            content: earlier.question,
            createdAt,
          })
          .onConflictDoNothing({
            target: [tutorMessages.threadId, tutorMessages.clientId],
          })
          .returning({ createdAt: tutorMessages.createdAt });
        if (insertedEarlier) lastInsertedAt = insertedEarlier.createdAt;
      }
      const historyRows = await tx
        .select()
        .from(tutorMessages)
        .where(eq(tutorMessages.threadId, target.id))
        .orderBy(desc(tutorMessages.seq))
        .limit(input.clientMessageId ? 13 : 12);
      const earlierMessages = input.earlier?.length
        ? await tx
            .select({
              id: tutorMessages.id,
              clientId: tutorMessages.clientId,
              role: tutorMessages.role,
              content: tutorMessages.content,
              createdAt: tutorMessages.createdAt,
            })
            .from(tutorMessages)
            .where(
              and(
                eq(tutorMessages.threadId, target.id),
                inArray(
                  tutorMessages.clientId,
                  input.earlier.map((message) => message.clientMessageId),
                ),
              ),
            )
            .orderBy(tutorMessages.seq)
        : [];
      const learnerMessageSelection = {
        seq: tutorMessages.seq,
        id: tutorMessages.id,
        clientId: tutorMessages.clientId,
        role: tutorMessages.role,
        content: tutorMessages.content,
        createdAt: tutorMessages.createdAt,
      };
      const mainMessageAt = nextMessageAt();
      const mainMessageValues = {
        userId: c.get('userId'),
        threadId: target.id,
        ...(input.clientMessageId ? { clientId: input.clientMessageId } : {}),
        activityId: activityId ?? null,
        exerciseId: exerciseId ?? null,
        lessonProblemId: input.lessonProblemId ?? null,
        role: 'user',
        content: input.question,
        createdAt: mainMessageAt,
      };
      const insertedMessages = input.clientMessageId
        ? await tx
            .insert(tutorMessages)
            .values(mainMessageValues)
            .onConflictDoNothing({
              target: [tutorMessages.threadId, tutorMessages.clientId],
            })
            .returning(learnerMessageSelection)
        : await tx
            .insert(tutorMessages)
            .values(mainMessageValues)
            .returning(learnerMessageSelection);
      let insertedMain = true;
      let learnerMessage = insertedMessages[0];
      if (!learnerMessage && input.clientMessageId) {
        insertedMain = false;
        [learnerMessage] = await tx
          .select(learnerMessageSelection)
          .from(tutorMessages)
          .where(
            and(
              eq(tutorMessages.threadId, target.id),
              eq(tutorMessages.clientId, input.clientMessageId),
            ),
          )
          .limit(1);
        if (
          learnerMessage &&
          (activityId !== undefined || exerciseId !== undefined || input.lessonProblemId)
        ) {
          const [adoptedMessage] = await tx
            .update(tutorMessages)
            .set({
              activityId: sql`coalesce(${tutorMessages.activityId}, ${activityId ?? null})`,
              exerciseId: sql`coalesce(${tutorMessages.exerciseId}, ${exerciseId ?? null})`,
              lessonProblemId: sql`coalesce(${tutorMessages.lessonProblemId}, ${input.lessonProblemId ?? null})`,
            })
            .where(
              and(
                eq(tutorMessages.id, learnerMessage.id),
                eq(tutorMessages.threadId, target.id),
                eq(tutorMessages.userId, c.get('userId')),
              ),
            )
            .returning(learnerMessageSelection);
          if (adoptedMessage) learnerMessage = adoptedMessage;
        }
      } else if (learnerMessage) {
        lastInsertedAt = learnerMessage.createdAt;
      }
      if (!learnerMessage) throw new Error('Tutor learner message was not saved');
      const updatedAt = lastInsertedAt ?? target.updatedAt;
      if (lastInsertedAt) {
        await tx.update(tutorThreads).set({ updatedAt }).where(eq(tutorThreads.id, target.id));
      }
      return {
        thread: { ...target, updatedAt },
        learnerMessage,
        createdThread,
        previousUpdatedAt,
        insertedMain,
        earlierMessages,
        history: historyRows
          .reverse()
          .filter((message) => message.id !== learnerMessage.id)
          .map((message) => ({
            role: message.role === 'assistant' ? ('tutor' as const) : ('learner' as const),
            content: message.content,
          })),
      };
    });

    if (signal.aborted) {
      return c.json({
        superseded: true,
        thread: request.thread,
      });
    }

    const rollbackFailedMessage = async () => {
      const abortedDuringRollback = new Error('Tutor request aborted during failure rollback');
      try {
        return await db.transaction(async (tx) => {
          await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, c.get('userId')))
            .for('update');
          if (signal.aborted) return false;
          if (request.insertedMain) {
            const [latestMessage] = await tx
              .select({ seq: tutorMessages.seq })
              .from(tutorMessages)
              .where(eq(tutorMessages.threadId, request.thread.id))
              .orderBy(desc(tutorMessages.seq))
              .limit(1);
            if (latestMessage?.seq === request.learnerMessage.seq) {
              await tx
                .delete(tutorMessages)
                .where(
                  and(
                    eq(tutorMessages.id, request.learnerMessage.id),
                    eq(tutorMessages.threadId, request.thread.id),
                    eq(tutorMessages.userId, c.get('userId')),
                  ),
                );
              if (signal.aborted) throw abortedDuringRollback;
              const [remainingMessage] = await tx
                .select({ id: tutorMessages.id })
                .from(tutorMessages)
                .where(eq(tutorMessages.threadId, request.thread.id))
                .limit(1);
              if (request.createdThread && !remainingMessage) {
                await tx
                  .delete(tutorThreads)
                  .where(
                    and(
                      eq(tutorThreads.id, request.thread.id),
                      eq(tutorThreads.userId, c.get('userId')),
                    ),
                  );
              } else if (
                !request.createdThread &&
                latestMessage?.seq === request.learnerMessage.seq &&
                request.previousUpdatedAt
              ) {
                await tx
                  .update(tutorThreads)
                  .set({ updatedAt: request.previousUpdatedAt })
                  .where(eq(tutorThreads.id, request.thread.id));
              }
            }
          }
          if (signal.aborted) throw abortedDuringRollback;
          return true;
        });
      } catch (cause) {
        if (cause === abortedDuringRollback) return false;
        throw cause;
      }
    };
    let result: Awaited<ReturnType<typeof service.respond>>;
    try {
      result = await service.respond(
        {
          conceptTitle: concept?.title ?? 'General',
          objectives: concept?.objectives.map((o) => o.text) ?? [],
          lessonSummary:
            lesson?.blocks
              .filter((b) => b.kind === 'summary')
              .map((b) => b.md)
              .join('\n') ?? '',
          exercisePrompt: exercise?.prompt ?? '',
          exerciseLabel: exercise ? input.questionLabel || 'Current question' : '',
          exerciseOptions: optionTexts.map(
            ({ text }, index) => `${String.fromCharCode(65 + index)}. ${text}`,
          ),
          answerKey: tutorAnswerKeyFor(exercise, optionTexts),
          learnerAnswer:
            (status === 'retrying' || status === 'answered') && currentAttempt && exercise
              ? tutorAnswerFor(exercise, currentAttempt.answer)
              : '',
          graderVerdict:
            status === 'retrying' || status === 'answered' ? graderVerdictFor(correct) : '',
          graderFeedback:
            (status === 'retrying' || status === 'answered') && currentAttempt
              ? formatGraderFeedback(currentAttempt.feedback, status === 'retrying')
              : '',
          hintLevel: 0,
          authoredHints:
            status === 'unanswered' || status === 'retrying' ? (exercise?.hints ?? []) : [],
          solution:
            status === 'unanswered' || status === 'retrying' ? '' : tutorSolutionFor(exercise),
          recentMistakes: [],
          question: input.question,
          mode: 'practice',
          history: request.history,
          problem_status: status,
          page: input.page ?? 'none',
          page_content: pageContent,
        },
        status === 'unanswered' ? 'nudge' : status === 'retrying' ? 'hint' : 'worked_step',
        index,
        signal,
      );
    } catch (cause) {
      if (signal.aborted) {
        return c.json({
          superseded: true,
          thread: request.thread,
        });
      }
      console.error('tutor reply failed', tutorFailureDetails(cause));
      await rollbackFailedMessage();
      if (signal.aborted) {
        return c.json({
          superseded: true,
          thread: request.thread,
        });
      }
      return c.json({ error: 'Tutor unavailable' }, 503);
    }
    if (signal.aborted) {
      return c.json({
        superseded: true,
        thread: request.thread,
      });
    }
    if (result.status !== 'ok' || !result.value) {
      if (signal.aborted) {
        return c.json({
          superseded: true,
          thread: request.thread,
        });
      }
      console.error('tutor reply failed', tutorFailureDetails(result.failure, result.status));
      await rollbackFailedMessage();
      if (signal.aborted) {
        return c.json({
          superseded: true,
          thread: request.thread,
        });
      }
      return c.json({ error: 'Tutor unavailable' }, 503);
    }
    const reply = result.value.message_md;
    const saveReply = () =>
      db.transaction(async (tx) => {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, c.get('userId')))
          .for('update');
        const [latestMessage] = await tx
          .select({ seq: tutorMessages.seq })
          .from(tutorMessages)
          .where(eq(tutorMessages.threadId, request.thread.id))
          .orderBy(desc(tutorMessages.seq))
          .limit(1);
        if (signal.aborted || latestMessage?.seq !== request.learnerMessage.seq) return null;
        const [target] = await tx
          .select()
          .from(tutorThreads)
          .where(eq(tutorThreads.id, request.thread.id))
          .for('update')
          .limit(1);
        if (!target || signal.aborted) return null;
        const tutorMessageAt = new Date(
          Math.max(deps.requestNow(c).getTime(), target.updatedAt.getTime() + 1),
        );
        const [assistantMessage] = await tx
          .insert(tutorMessages)
          .values({
            userId: c.get('userId'),
            threadId: target.id,
            activityId: activityId ?? null,
            exerciseId: exerciseId ?? null,
            lessonProblemId: input.lessonProblemId ?? null,
            role: 'assistant',
            content: reply,
            llmCallId: result.callId ?? null,
            createdAt: tutorMessageAt,
          })
          .returning({
            id: tutorMessages.id,
            clientId: tutorMessages.clientId,
            role: tutorMessages.role,
            content: tutorMessages.content,
            createdAt: tutorMessages.createdAt,
          });
        if (!assistantMessage) throw new Error('Tutor reply was not saved');
        if (signal.aborted) throw new Error('Tutor request aborted before reply was saved');
        await tx
          .update(tutorThreads)
          .set({ updatedAt: tutorMessageAt })
          .where(eq(tutorThreads.id, target.id));
        if (signal.aborted) throw new Error('Tutor request aborted before reply was saved');
        return {
          thread: { ...target, updatedAt: tutorMessageAt },
          messages: [
            ...request.earlierMessages.filter(
              (message) => message.clientId !== request.learnerMessage.clientId,
            ),
            request.learnerMessage,
            assistantMessage,
          ].map(({ id, clientId, role, content, createdAt }) => ({
            id,
            clientId,
            role,
            content,
            createdAt,
          })),
        };
      });
    let saved: Awaited<ReturnType<typeof saveReply>> | null;
    try {
      saved = await saveReply();
    } catch (cause) {
      if (!signal.aborted) throw cause;
      saved = null;
    }
    if (!saved) {
      return c.json({
        superseded: true,
        thread: request.thread,
      });
    }
    return c.json(saved);
  };
  api.post('/tutor/threads', (c) => send(c));
  api.post('/tutor/threads/:id/messages', (c) => send(c, c.req.param('id')));
}
