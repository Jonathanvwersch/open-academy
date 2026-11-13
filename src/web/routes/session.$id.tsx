import { useQueries, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Alert, AlertDescription } from '@/ui/alert.js';
import { Badge } from '@/ui/badge.js';
import { Button } from '@/ui/button.js';
import { Card, CardContent } from '@/ui/card.js';
import { apiFetch } from '../authenticated-fetch.js';
import {
  type AnswerOptions,
  ExerciseForm,
  FeedbackPanel,
  HintLadder,
  LessonBlock,
  Markdown,
} from '../components';
import { LessonRunner } from '../lesson/LessonRunner.js';
import {
  exerciseQueryOptions,
  lessonQueryOptions,
  lessonRunQueryOptions,
  paperStatusLabel,
  papersQueryOptions,
  projectQueryOptions,
  sessionQueryOptions,
  todayQueryOptions,
} from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { QuestionProgress, type QuestionState } from '../session/QuestionProgress.js';
import { SessionActivityHeader } from '../session/SessionActivityHeader.js';
import { XpGoalBar } from '../session/XpGoalBar.js';
import { SessionSkeleton } from '../skeletons.js';
import { TutorLauncher, useTutorSidebar } from '../tutor/TutorSidebar.js';

export const Route = createFileRoute('/session/$id')({
  pendingComponent: SessionSkeleton,
  validateSearch: z.object({ activity: z.string().optional() }),
  loader: async ({ context, params }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(params.id));
    await Promise.all([
      context.queryClient.ensureQueryData(papersQueryOptions()),
      context.queryClient.ensureQueryData(todayQueryOptions()),
      ...session.activities
        .filter((activity) => activity.kind === 'lab' && activity.projectId)
        .map((activity) =>
          context.queryClient.ensureQueryData(projectQueryOptions(activity.projectId ?? '')),
        ),
    ]);
    const lessons = await Promise.all(
      session.activities.map((activity) =>
        ['learn', 'practice', 'remediate', 'transfer'].includes(activity.kind) &&
        activity.conceptId &&
        activity.lessonAvailable
          ? context.queryClient.ensureQueryData(lessonQueryOptions(activity.conceptId))
          : Promise.resolve(null),
      ),
    );
    await Promise.all(
      lessons.map((lesson, index) =>
        lesson?.knowledge_points?.length
          ? context.queryClient.ensureQueryData(
              lessonRunQueryOptions(session.activities[index]?.conceptId ?? null),
            )
          : Promise.resolve(null),
      ),
    );
    const exerciseIds = new Set(session.activities.flatMap((activity) => activity.exerciseIds));
    for (const lesson of lessons) {
      for (const block of lesson?.blocks ?? []) {
        if (block.exercise) exerciseIds.add(block.exercise);
      }
    }
    await Promise.all(
      [...exerciseIds].map((exerciseId) =>
        context.queryClient.ensureQueryData(exerciseQueryOptions(exerciseId)),
      ),
    );
  },
  errorComponent: () => (
    <RouteLoadError
      message="This session could not be resumed."
      className="text-sm text-destructive"
    />
  ),
  component: SessionPage,
});

function SessionCompletion({
  xp,
  onFinish,
  finishing,
}: {
  xp: { session: number; today: number; goal: number };
  onFinish: () => void;
  finishing: boolean;
}) {
  return (
    <section className="space-y-4">
      <h1 className="text-3xl font-semibold">Session complete</h1>
      <p className="text-4xl font-bold">+{xp.session} XP</p>
      <p className="text-muted-foreground">
        Today: {xp.today} / {xp.goal} XP
      </p>
      <XpGoalBar today={xp.today} goal={xp.goal} previousToday={xp.today - xp.session} />
      {xp.today >= xp.goal ? <p className="font-medium">Daily goal reached</p> : null}
      <p className="text-muted-foreground">Your progress has been saved.</p>
      <Button type="button" onClick={onFinish} loading={finishing}>
        Finish session
      </Button>
    </section>
  );
}

function SessionPage() {
  const { id } = Route.useParams();
  const { activity: requestedActivityId } = Route.useSearch();
  const queryClient = useQueryClient();
  const tutorSidebar = useTutorSidebar();
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [hints, setHints] = useState<
    {
      level: number;
      text: string;
      revealedSolution: boolean;
    }[]
  >([]);
  const [tutorUnavailable, setTutorUnavailable] = useState(false);
  const [completedLessonChecks, setCompletedLessonChecks] = useState<Set<string>>(new Set());
  const [submittingAnswer, setSubmittingAnswer] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [endingSession, setEndingSession] = useState(false);
  const [markingLessonViewed, setMarkingLessonViewed] = useState(false);
  const hintButton = useRef<HTMLButtonElement>(null);
  const [timeAnchor, setTimeAnchor] = useState<{ serverTime: number; clientTime: number } | null>(
    null,
  );
  const sessionQuery = useSuspenseQuery(sessionQueryOptions(id));
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (sessionQuery.data?.serverNow) {
      setTimeAnchor({
        serverTime: Date.parse(sessionQuery.data.serverNow),
        clientTime: Date.now(),
      });
    }
  }, [sessionQuery.data?.serverNow]);
  const activities = sessionQuery.data.activities;
  const activeActivity =
    activities.find((item) => item.status === 'in_progress') ??
    activities.find((item) => item.status === 'planned');
  const lessonRunConceptIds = [
    ...new Set(
      activities.flatMap((item) =>
        item.kind === 'learn' && item.conceptId && item.lessonAvailable ? [item.conceptId] : [],
      ),
    ),
  ];
  const lessonRunQueries = useQueries({
    queries: lessonRunConceptIds.map((conceptId) => ({
      ...lessonRunQueryOptions(conceptId),
      retry: false,
    })),
  });
  const lessonRunsByConcept = new Map(
    lessonRunConceptIds.map((conceptId, index) => [conceptId, lessonRunQueries[index]?.data?.run]),
  );
  const lessonRunsPending = lessonRunQueries.some((query) => query.isPending);
  const completedLesson = activities.find((item) => {
    if (
      item.kind !== 'learn' ||
      item.status !== 'completed' ||
      !item.conceptId ||
      item.progress?.quizContinued
    ) {
      return false;
    }
    const run = lessonRunsByConcept.get(item.conceptId);
    return (
      run?.status === 'completed' ||
      (run?.status === 'quiz' &&
        (item.progress?.finalQuestionContinued || item.exerciseIds.length === 0))
    );
  });
  const completedFinal = activities.find(
    (item) =>
      item.kind === 'learn' &&
      (item.status === 'completed' || item.status === 'in_progress') &&
      item.progress?.lessonRunnerContinued &&
      !item.progress.finalQuestionContinued &&
      (item.progress.completedExerciseIds ?? []).some((exerciseId) =>
        item.exerciseIds.includes(exerciseId),
      ),
  );
  const requestedCompletedActivity = activities.find(
    (item) => item.id === requestedActivityId && item.status === 'completed',
  );
  const activity =
    completedLesson ??
    completedFinal ??
    (requestedCompletedActivity && activeActivity ? requestedCompletedActivity : undefined) ??
    activeActivity;
  const showingRequestedCompletedActivity = activity?.id === requestedCompletedActivity?.id;
  const showingCompletedFinal = activity?.id === completedFinal?.id;
  const labProjectId = activity?.kind === 'lab' ? activity.projectId : undefined;
  const labProjectQuery = useQuery({
    ...projectQueryOptions(labProjectId ?? ''),
    enabled: Boolean(labProjectId),
  });
  const exerciseId = showingCompletedFinal
    ? activity?.exerciseIds.find((candidate) =>
        (activity.progress?.completedExerciseIds ?? []).includes(candidate),
      )
    : activity?.exerciseIds.find(
        (candidate) => !(activity.progress?.completedExerciseIds ?? []).includes(candidate),
      );
  const currentResult = exerciseId && result?.exerciseId === exerciseId ? result : null;
  const exerciseQuery = useSuspenseQuery(exerciseQueryOptions(exerciseId ?? null));
  const activityScrollKey = activity
    ? `${activity.id}:${activity.progress?.lessonViewed ?? ''}`
    : '';
  useEffect(() => {
    if (activityScrollKey) window.scrollTo({ top: 0 });
  }, [activityScrollKey]);
  useEffect(() => {
    if (activity?.id && exerciseId) {
      setResult((current) => {
        if (current?.exerciseId === exerciseId) return current;
        const lastAttempt = activity.lastAttempt;
        return lastAttempt && lastAttempt.exerciseId === exerciseId
          ? { ...lastAttempt, status: lastAttempt.status ?? 'graded' }
          : null;
      });
      setHints([]);
      setTutorUnavailable(false);
      setSubmitError('');
    }
  }, [activity?.id, activity?.lastAttempt, exerciseId]);
  useEffect(() => {
    const session = sessionQuery.data;
    if (!session?.startedAt || !session.plannedMinutes) return;
    const elapsed =
      timeAnchor && session.startedAt
        ? Math.max(
            0,
            Math.floor(
              (timeAnchor.serverTime -
                Date.parse(session.startedAt) +
                (clock - timeAnchor.clientTime)) /
                60_000,
            ),
          )
        : 0;
    const key = `replanned:${id}`;
    if (elapsed > session.plannedMinutes * 1.3 && !window.sessionStorage.getItem(key)) {
      window.sessionStorage.setItem(key, 'true');
      void apiFetch(`/api/sessions/${id}/replan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          remainingBudgetMinutes: Math.max(0, session.plannedMinutes - elapsed),
        }),
      }).then(() => queryClient.invalidateQueries({ queryKey: ['session', id] }));
    }
  }, [clock, id, queryClient, sessionQuery.data, timeAnchor]);
  const lessonQuery = useSuspenseQuery(
    lessonQueryOptions(
      activity &&
        ['learn', 'practice', 'remediate', 'transfer'].includes(activity.kind) &&
        activity.lessonAvailable
        ? (activity.conceptId ?? null)
        : null,
    ),
  );
  const lesson = lessonQuery.data;
  const lessonRunnerActive = Boolean(
    activity?.kind === 'learn' &&
      activity.conceptId &&
      lesson?.knowledge_points?.length &&
      (!activity.progress?.lessonRunnerContinued ||
        (activity.progress.lessonRunnerContinued &&
          activity.progress.finalQuestionContinued &&
          !activity.progress.quizContinued)),
  );
  useEffect(() => {
    if (lessonRunnerActive) return;
    if (!activity) {
      tutorSidebar.clearContext();
      return;
    }
    const allowed = !['diagnostic', 'review', 'quick_check', 'assessment'].includes(activity.kind);
    tutorSidebar.setContext({
      conceptId: activity.conceptId ?? undefined,
      conceptTitle: activity.conceptTitle ?? undefined,
      activityId: activity.id,
      exerciseId,
      questionLabel:
        activity.kind === 'learn' && lesson?.final === exerciseId
          ? 'Final question'
          : exerciseId && activity.exerciseIds.length > 1
            ? `Question ${activity.exerciseIds.indexOf(exerciseId) + 1} of ${activity.exerciseIds.length}`
            : undefined,
      page: 'session',
      pageLabel: activity.conceptTitle ?? undefined,
      allowed,
      enabled: sessionQuery.data.tutorEnabled,
    });
    return () => tutorSidebar.clearContext();
  }, [
    activity,
    exerciseId,
    lesson?.final,
    lessonRunnerActive,
    sessionQuery.data.tutorEnabled,
    tutorSidebar,
  ]);

  const markLessonViewed = async () => {
    if (!activity) return;
    setMarkingLessonViewed(true);
    try {
      await apiFetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(activity.progress ?? {}), lessonViewed: true }),
      });
      await queryClient.invalidateQueries({ queryKey: ['session', id] });
    } finally {
      setMarkingLessonViewed(false);
    }
  };

  const completeActivity = async () => {
    if (!activity) return;
    setContinuing(true);
    try {
      await apiFetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(activity.progress ?? {}), complete: true }),
      });
      await queryClient.invalidateQueries({ queryKey: ['session', id] });
    } finally {
      setContinuing(false);
    }
  };

  const submitAnswer = async (answer: unknown) => {
    if (!exerciseId || !activity) return;
    setSubmittingAnswer(true);
    setSubmitError('');
    const mode =
      activity.kind === 'quick_check' || activity.kind === 'diagnostic'
        ? 'assessment'
        : activity.kind === 'review'
          ? 'review'
          : 'practice';
    try {
      const response = await apiFetch('/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exerciseId, activityId: activity.id, answer, mode }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['session', id] });
        return;
      }
      if (response.ok || (response.status === 422 && data.status === 'invalid')) {
        setResult({ ...data, exerciseId });
      } else {
        setSubmitError(typeof data.error === 'string' ? data.error : 'Your answer was not saved.');
      }
      if (response.ok && data.status !== 'invalid') {
        setHints([]);
        setTutorUnavailable(false);
      }
    } finally {
      setSubmittingAnswer(false);
    }
  };
  const handleHint = (nextHint: {
    level: number;
    text: string;
    revealedSolution: boolean;
    tutorUnavailable?: boolean;
  }) => {
    if (nextHint.text) {
      const entry = {
        level: nextHint.level,
        text: nextHint.text,
        revealedSolution: nextHint.revealedSolution,
      };
      setHints((current) => {
        const existingIndex = current.findIndex((hint) => hint.level === entry.level);
        if (existingIndex < 0) return [...current, entry];
        const updated = [...current];
        updated[existingIndex] = entry;
        return updated;
      });
    }
    setTutorUnavailable(Boolean(nextHint.tutorUnavailable));
  };
  const continueNext = useCallback(async () => {
    if (!activity) return;
    setContinuing(true);
    try {
      const currentExerciseId = exerciseId;
      if (activity.kind !== 'learn' && currentExerciseId) {
        const completedExerciseIds = new Set([
          ...(activity.progress?.completedExerciseIds ?? []),
          currentExerciseId,
        ]);
        const hasNextExercise = activity.exerciseIds.some(
          (candidate) => !completedExerciseIds.has(candidate),
        );
        if (hasNextExercise) {
          const currentOutcome: 'correct' | 'incorrect' | undefined =
            currentResult &&
            currentResult.status !== 'invalid' &&
            currentResult.status !== 'self_check_required'
              ? Number(currentResult.correct) > 0
                ? 'correct'
                : 'incorrect'
              : undefined;
          queryClient.setQueryData(sessionQueryOptions(id).queryKey, (session) => {
            if (!session) return session;
            return {
              ...session,
              activities: session.activities.map((item) =>
                item.id === activity.id
                  ? {
                      ...item,
                      progress: {
                        ...item.progress,
                        completedExerciseIds: [
                          ...new Set([
                            ...(item.progress?.completedExerciseIds ?? []),
                            currentExerciseId,
                          ]),
                        ],
                        ...(currentOutcome
                          ? {
                              outcomes: {
                                ...(item.progress?.outcomes ?? {}),
                                [currentExerciseId]: currentOutcome,
                              },
                            }
                          : {}),
                      },
                    }
                  : item,
              ),
            };
          });
          void queryClient.invalidateQueries({ queryKey: ['session', id] });
          return;
        }
      }
      const freshSession = await queryClient.fetchQuery({
        ...sessionQueryOptions(id),
        staleTime: 0,
      });
      const freshActivity = freshSession.activities.find((item) => item.id === activity.id);
      let finalQuestionContinued = false;
      if (
        currentExerciseId &&
        freshActivity?.kind === 'learn' &&
        freshActivity.progress?.lessonRunnerContinued &&
        !freshActivity.progress.finalQuestionContinued &&
        (freshActivity.progress.completedExerciseIds ?? []).includes(currentExerciseId)
      ) {
        await apiFetch(`/api/sessions/${id}/activities/${freshActivity.id}/progress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(freshActivity.progress ?? {}),
            finalQuestionContinued: true,
          }),
        });
        finalQuestionContinued = true;
      }
      if (finalQuestionContinued) {
        await queryClient.invalidateQueries({ queryKey: ['session', id] });
      }
    } finally {
      setContinuing(false);
    }
  }, [activity, currentResult, exerciseId, id, queryClient]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
          ['radio', 'checkbox', 'combobox'].includes(target.getAttribute('role') ?? ''))
      ) {
        return;
      }
      if (event.key.toLowerCase() === 'h') {
        event.preventDefault();
        hintButton.current?.click();
      } else if (event.key.toLowerCase() === 'n' || event.key === 'ArrowRight') {
        if (currentResult && currentResult.status !== 'invalid' && !currentResult.retryAllowed) {
          event.preventDefault();
          void continueNext();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [continueNext, currentResult]);
  const continueLessonRunner = async (_status: 'quiz' | 'completed', stage: 'final' | 'done') => {
    if (!activity) return;
    const finalQuestionPending =
      stage === 'final' &&
      !!lesson?.final &&
      !(activity.progress?.completedExerciseIds ?? []).includes(lesson.final);
    await apiFetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(activity.progress ?? {}),
        lessonRunnerContinued: true,
        ...(finalQuestionPending ? {} : { finalQuestionContinued: true }),
        ...(stage === 'done' ? { complete: true, quizContinued: true } : {}),
      }),
    });
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };

  const endSession = async () => {
    setEndingSession(true);
    try {
      await apiFetch(`/api/sessions/${id}/end`, { method: 'POST' });
      window.location.href = '/';
    } finally {
      setEndingSession(false);
    }
  };

  if (lessonRunsPending) return <SessionSkeleton />;

  if (!activity) {
    return (
      <SessionCompletion
        xp={sessionQuery.data.xp}
        onFinish={endSession}
        finishing={endingSession}
      />
    );
  }
  if (showingRequestedCompletedActivity) {
    const title =
      activity.kind === 'paper'
        ? 'Paper reading'
        : (activity.conceptTitle ?? sessionActivityLabel(activity.kind));
    return (
      <section className="space-y-6">
        <SessionActivityHeader title={title} label={sessionActivityLabel(activity.kind)} />
        <p role="status">{title} complete.</p>
        <Button asChild>
          <Link to="/session/$id" params={{ id }} search={{}}>
            Continue
          </Link>
        </Button>
      </section>
    );
  }
  const mode =
    activity.kind === 'review'
      ? 'review'
      : activity.kind === 'quick_check' || activity.kind === 'diagnostic'
        ? 'assessment'
        : 'practice';
  const activityLabel = sessionActivityLabel(activity.kind);
  const activityTitle =
    (activity.kind === 'lab' ? labProjectQuery.data?.project.title : undefined) ??
    activity.conceptTitle ??
    (activity.kind === 'paper'
      ? 'Paper reading'
      : activity.kind === 'review'
        ? 'Review'
        : activity.kind === 'lab'
          ? 'Project'
          : ['quick_check', 'diagnostic', 'assessment'].includes(activity.kind)
            ? 'Quiz'
            : sessionActivityLabel(activity.kind));
  const lessonHref =
    activity.conceptId && activity.lessonAvailable
      ? `/lessons/${encodeURIComponent(activity.conceptId)}?from=${encodeURIComponent(id)}`
      : undefined;
  const canSubmitAnswer =
    !currentResult ||
    currentResult.status === 'invalid' ||
    currentResult.status === 'self_check_required' ||
    (currentResult.followUp === true && currentResult.retryAllowed === true) ||
    (Number(currentResult.correct) === 0 && currentResult.retryAllowed === true);
  const triesLeft = Math.max(0, 2 - Number(currentResult?.attemptNo ?? 1));
  const helpActions =
    mode !== 'assessment' ? (
      <div className="flex flex-wrap gap-2">
        <HintLadder
          exerciseId={exerciseId ?? ''}
          activityId={activity.id}
          hintCount={exerciseQuery.data?.hintCount ?? 0}
          tutorEnabled={sessionQuery.data.tutorEnabled}
          onHint={handleHint}
          mode={mode === 'review' ? 'review' : 'practice'}
          buttonRef={hintButton}
        />
        {mode === 'practice' && exerciseId && sessionQuery.data.tutorEnabled ? (
          <TutorLauncher
            context={{
              conceptId: activity.conceptId ?? undefined,
              conceptTitle: activity.conceptTitle ?? undefined,
              activityId: activity.id,
              exerciseId,
              allowed: true,
              enabled: sessionQuery.data.tutorEnabled,
            }}
            greeting={
              currentResult && currentResult.status !== 'invalid'
                ? 'What would you like to know about this answer?'
                : undefined
            }
          />
        ) : null}
      </div>
    ) : null;
  const submitLabel =
    currentResult?.status === 'self_check_required'
      ? 'Submit self-check'
      : currentResult?.followUp === true && currentResult.retryAllowed === true
        ? 'Submit again'
        : Number(currentResult?.correct) === 0 && currentResult?.retryAllowed === true
          ? `Try again · ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left`
          : 'Submit answer';
  const currentResultOutcome =
    currentResult &&
    currentResult.status !== 'invalid' &&
    currentResult.status !== 'self_check_required'
      ? Number(currentResult.correct) > 0
        ? 'correct'
        : 'incorrect'
      : null;
  const completedExerciseIds = new Set(activity.progress?.completedExerciseIds ?? []);
  const questionStates: QuestionState[] = activity.exerciseIds.map((candidate) => {
    if (candidate === exerciseId) {
      return currentResultOutcome ?? 'current';
    }
    if (completedExerciseIds.has(candidate)) {
      return activity.progress?.outcomes?.[candidate] ?? 'done';
    }
    return 'upcoming';
  });
  const finalAnswered =
    !lesson?.final || (activity?.progress?.completedExerciseIds ?? []).includes(lesson.final);
  if (lessonRunnerActive && activity?.kind === 'learn' && activity.conceptId) {
    return (
      <LessonRunner
        conceptId={activity.conceptId}
        activityId={activity.id}
        sessionId={id}
        title={activity.conceptTitle ?? activity.conceptId}
        activityLabel={activityLabel}
        lessonHref={lessonHref}
        tutorEnabled={sessionQuery.data.tutorEnabled}
        finalAnswered={Boolean(finalAnswered)}
        onContinue={continueLessonRunner}
      />
    );
  }
  if (activity.kind === 'paper') {
    return (
      <section className="space-y-6">
        <SessionActivityHeader title="Paper reading" label="Paper" />
        <PaperActivity
          sessionId={id}
          activityId={activity.id}
          completed={activity.status === 'completed'}
          tutorEnabled={sessionQuery.data.tutorEnabled}
          onSkip={async () => {
            await apiFetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ complete: true }),
            });
            await queryClient.invalidateQueries({ queryKey: ['session', id] });
          }}
        />
      </section>
    );
  }
  if (activity.kind === 'learn' && lesson?.knowledge_points?.length && !exerciseQuery.data) {
    return <SessionSkeleton />;
  }
  if (
    activity.kind === 'learn' &&
    !activity.progress?.lessonViewed &&
    !lesson?.knowledge_points?.length &&
    lesson?.blocks.length
  ) {
    const answeredOnServer = new Set(activity.progress?.completedExerciseIds ?? []);
    const checksPending = lesson.blocks.some(
      (block) =>
        block.exercise &&
        !completedLessonChecks.has(block.exercise) &&
        !answeredOnServer.has(block.exercise),
    );
    const orderedBlocks = [
      ...lesson.blocks.filter((block) => block.kind !== 'objective' && block.kind !== 'summary'),
      ...lesson.blocks.filter((block) => block.kind === 'summary'),
    ];
    return (
      <section className="space-y-6">
        <SessionActivityHeader
          title={activityTitle}
          label={activityLabel}
          lessonHref={lessonHref}
        />
        <div className="space-y-5">
          {orderedBlocks.map((block) => (
            <LessonBlock
              key={`${block.kind}-${block.md ?? block.exercise ?? 'block'}`}
              kind={block.kind}
              md={block.md}
            >
              {block.exercise ? (
                <InlineLessonCheck
                  key={`${activity.id}:${block.exercise}`}
                  exerciseId={block.exercise}
                  activityId={activity.id}
                  onDone={() =>
                    setCompletedLessonChecks((current) =>
                      new Set(current).add(block.exercise ?? ''),
                    )
                  }
                  onConflict={() => queryClient.invalidateQueries({ queryKey: ['session', id] })}
                />
              ) : null}
            </LessonBlock>
          ))}
        </div>
        <Button
          type="button"
          onClick={markLessonViewed}
          loading={markingLessonViewed}
          disabled={checksPending}
        >
          Continue to practice
        </Button>
        {checksPending ? (
          <p className="text-sm text-muted-foreground">
            Answer or skip the check above to continue.
          </p>
        ) : null}
      </section>
    );
  }
  return (
    <section className="space-y-6">
      <SessionActivityHeader
        title={activityTitle}
        label={activityLabel}
        lessonHref={lessonHref}
        subtitle={
          activity.kind === 'learn' && lesson?.final === exerciseId ? 'Final question' : undefined
        }
      />
      {exerciseQuery.data ? (
        <Card data-testid="session-exercise" data-exercise-container="">
          <CardContent className="space-y-5">
            <QuestionProgress states={questionStates} />
            <div data-testid="exercise-prompt">
              <Markdown>{exerciseQuery.data.prompt}</Markdown>
            </div>
            <ExerciseForm
              key={`${activity.id}:${exerciseId}`}
              exercise={exerciseQuery.data}
              onSubmit={submitAnswer}
              explainStep={
                currentResult?.status === 'self_check_required' ? 'self-check' : 'answer'
              }
              readOnlyAnswer={
                typeof currentResult?.yourAnswer === 'string' ? currentResult.yourAnswer : undefined
              }
              submittedAnswer={currentResult?.yourAnswer}
              answerOptions={currentResult?.answerOptions as AnswerOptions | undefined}
              locked={!canSubmitAnswer && currentResult?.status !== 'invalid'}
              submitLabel={submitLabel}
              primaryAction={
                !canSubmitAnswer
                  ? { label: 'Continue', onClick: () => void continueNext(), loading: continuing }
                  : undefined
              }
              loading={submittingAnswer}
              actions={helpActions}
            />
            {submitError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            ) : null}
            {currentResult && currentResult.status !== 'invalid' ? (
              <FeedbackPanel
                result={currentResult}
                hideAnswerLines={['mc', 'debug', 'explain'].includes(exerciseQuery.data.type)}
              />
            ) : null}
            {currentResult?.status === 'invalid' ? (
              <Alert variant="destructive">
                <AlertDescription>
                  <Markdown inline>{String(currentResult.feedback)}</Markdown>
                </AlertDescription>
              </Alert>
            ) : null}
            {hints.length || tutorUnavailable ? (
              <div className="space-y-3">
                {hints.map((hint) => (
                  <div key={hint.level} className="rounded-lg bg-muted p-4 text-sm">
                    <p className="font-medium">
                      {hint.revealedSolution ? 'Solution' : `Hint ${hint.level}`}
                    </p>
                    <Markdown>{hint.text}</Markdown>
                  </div>
                ))}
                {tutorUnavailable ? (
                  <p className="text-xs text-muted-foreground">Tutor unavailable right now.</p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : !exerciseId ? (
        <Card>
          <CardContent className="space-y-4">
            <h2 className="text-lg font-semibold capitalize">
              {activity.kind === 'lab'
                ? (labProjectQuery.data?.project.title ?? 'Project')
                : activity.kind.replace('_', ' ')}
            </h2>
            <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
              {activity.kind === 'lab'
                ? labProjectQuery.data?.latestSubmission
                  ? `${
                      labProjectQuery.data.latestSubmission.results.tests.filter(
                        (test) => test.passed,
                      ).length
                    } of ${labProjectQuery.data.checksTotal} checks passed`
                  : 'Not started'
                : activity.kind === 'teachback'
                  ? 'Summarize the main idea from memory before continuing.'
                  : activity.kind === 'reflect'
                    ? 'Take a moment to reflect on what you learned and what remains unclear.'
                    : 'No eligible exercise is available for this activity yet.'}
            </p>
            {activity.kind === 'lab' &&
            activity.projectId &&
            labProjectQuery.data?.project.status === 'authored' &&
            labProjectQuery.data.checksTotal > 0 ? (
              <Button variant="outline" asChild>
                <Link to="/projects/$projectId" params={{ projectId: activity.projectId }}>
                  Open project
                </Link>
              </Button>
            ) : null}
            <Button type="button" onClick={completeActivity} loading={continuing}>
              {activity.kind === 'lab' ? 'Done for today' : 'Continue'}
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function sessionActivityLabel(kind: string) {
  const labels: Record<string, string> = {
    learn: 'New lesson',
    practice: 'Practice',
    remediate: 'Remediation',
    transfer: 'Transfer',
    review: 'Review',
    quick_check: 'Quiz',
    diagnostic: 'Quiz',
    assessment: 'Assessment',
    lab: 'Project',
    teachback: 'Teach-back',
    reflect: 'Reflection',
    paper: 'Paper',
  };
  return labels[kind] ?? kind.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function PaperActivity({
  sessionId,
  activityId,
  completed,
  tutorEnabled,
  onSkip,
}: {
  sessionId: string;
  activityId: string;
  completed: boolean;
  tutorEnabled: boolean;
  onSkip: () => Promise<void>;
}) {
  const [skipping, setSkipping] = useState(false);
  const { data: papersData } = useSuspenseQuery(papersQueryOptions());
  const { data: today } = useSuspenseQuery(todayQueryOptions());
  const papers = papersData.weeks.find((week) => week.week === today.week)?.papers ?? [];
  const skip = async () => {
    setSkipping(true);
    try {
      await onSkip();
    } finally {
      setSkipping(false);
    }
  };
  if (completed) {
    return <p role="status">Paper reading complete.</p>;
  }
  return (
    <div className="space-y-4">
      <p>Pick one of this week&apos;s papers to read.</p>
      <ul className="divide-y rounded-md border">
        {papers.map((paper) => (
          <li key={paper.id}>
            <Link
              to="/papers/$paperId"
              params={{ paperId: paper.id }}
              search={{ from: sessionId, activity: activityId }}
              className="block cursor-pointer px-4 py-3 hover:bg-muted/60"
            >
              <span className="font-medium">
                <Markdown inline>{paper.title}</Markdown>
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                <Markdown inline>{paper.authors}</Markdown> · {paper.year} · ~{paper.est_minutes}{' '}
                min
              </span>
              <Badge
                variant="secondary"
                className={
                  paper.status === 'completed'
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : ''
                }
              >
                {paperStatusLabel(paper.status)}
              </Badge>
            </Link>
          </li>
        ))}
      </ul>
      <Button type="button" variant="outline" loading={skipping} onClick={() => void skip()}>
        Skip for today
      </Button>
      {!tutorEnabled ? (
        <p className="text-sm text-muted-foreground">Tutor grading is unavailable.</p>
      ) : null}
    </div>
  );
}

function InlineLessonCheck({
  exerciseId,
  activityId,
  onDone,
  onConflict,
}: {
  exerciseId: string;
  activityId: string;
  onDone: () => void;
  onConflict: () => Promise<void>;
}) {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const { data: exercise } = useSuspenseQuery(exerciseQueryOptions(exerciseId));
  const submit = async (answer: unknown) => {
    setSubmitting(true);
    setSubmitError('');
    try {
      const response = await apiFetch('/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exerciseId, activityId, answer, mode: 'practice' }),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status === 409) {
        await onConflict();
        return;
      }
      if (response.ok || (response.status === 422 && data.status === 'invalid')) {
        setResult(data);
      } else {
        setSubmitError(typeof data.error === 'string' ? data.error : 'Your answer was not saved.');
      }
      if (response.ok && data.status !== 'invalid') onDone();
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Card>
      <CardContent className="space-y-3">
        {exercise ? (
          <>
            <Markdown>{exercise.prompt}</Markdown>
            {result ? (
              result.status === 'invalid' ? (
                <Alert variant="destructive">
                  <AlertDescription>
                    <Markdown inline>{String(result.feedback ?? 'Invalid answer')}</Markdown>
                  </AlertDescription>
                </Alert>
              ) : (
                <FeedbackPanel
                  result={result}
                  hideAnswerLines={
                    ['mc', 'debug', 'explain'].includes(exercise.type) &&
                    result.retryAllowed === true
                  }
                />
              )
            ) : null}
            {!result || result.status === 'invalid' || result.retryAllowed ? (
              <ExerciseForm
                key={`${activityId}:${exerciseId}`}
                exercise={exercise}
                onSubmit={submit}
                loading={submitting}
              />
            ) : null}
            {submitError ? (
              <p role="alert" className="text-sm text-destructive">
                {submitError}
              </p>
            ) : null}
          </>
        ) : null}
        {!result ? (
          <Button type="button" variant="link" className="px-0" onClick={onDone}>
            Skip this check
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
