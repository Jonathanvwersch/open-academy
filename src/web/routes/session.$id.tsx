import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
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
  type LessonRunPayload,
  lessonQueryOptions,
  lessonRunQueryOptions,
  paperStatusLabel,
  papersQueryOptions,
  sessionQueryOptions,
  todayQueryOptions,
} from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { QuestionProgress, type QuestionState } from '../session/QuestionProgress.js';
import { SessionActivityHeader } from '../session/SessionActivityHeader.js';
import { LessonSkeleton } from '../skeletons.js';
import { TutorLauncher, useTutorSidebar } from '../tutor/TutorSidebar.js';

export const Route = createFileRoute('/session/$id')({
  pendingComponent: LessonSkeleton,
  validateSearch: z.object({ activity: z.string().optional() }),
  loader: async ({ context, params }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(params.id));
    await Promise.all([
      context.queryClient.ensureQueryData(papersQueryOptions()),
      context.queryClient.ensureQueryData(todayQueryOptions()),
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

function SessionPage() {
  const { id } = Route.useParams();
  const { activity: requestedActivityId } = Route.useSearch();
  const queryClient = useQueryClient();
  const tutorSidebar = useTutorSidebar();
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [hint, setHint] = useState<{
    level: number;
    text: string;
    revealedSolution: boolean;
    tutorUnavailable?: boolean;
  } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
  const completedLesson = activities.find((item) => {
    if (
      item.kind !== 'learn' ||
      item.status !== 'completed' ||
      !item.conceptId ||
      item.progress?.lessonRunnerContinued
    ) {
      return false;
    }
    const run = queryClient.getQueryData<LessonRunPayload>(['lesson-run', item.conceptId])?.run;
    return run?.status === 'needs_retry' || run?.status === 'completed';
  });
  const completedFinal = activities.find(
    (item) =>
      item.kind === 'learn' &&
      item.status === 'completed' &&
      item.progress?.lessonRunnerContinued &&
      !item.progress.finalQuestionContinued &&
      (item.progress.completedExerciseIds ?? []).some((exerciseId) =>
        item.exerciseIds.includes(exerciseId),
      ),
  );
  const requestedPaperActivity = activities.find(
    (item) => item.id === requestedActivityId && item.kind === 'paper',
  );
  const activity =
    (requestedPaperActivity?.status === 'completed' ? requestedPaperActivity : undefined) ??
    completedLesson ??
    completedFinal ??
    activeActivity;
  const showingCompletedFinal = activity?.id === completedFinal?.id;
  const exerciseId = showingCompletedFinal
    ? activity?.exerciseIds.find((candidate) =>
        (activity.progress?.completedExerciseIds ?? []).includes(candidate),
      )
    : activity?.exerciseIds.find(
        (candidate) => !(activity.progress?.completedExerciseIds ?? []).includes(candidate),
      );
  const exerciseQuery = useSuspenseQuery(exerciseQueryOptions(exerciseId ?? null));
  const activityScrollKey = activity
    ? `${activity.id}:${activity.progress?.lessonViewed ?? ''}`
    : '';
  useEffect(() => {
    if (activityScrollKey) window.scrollTo({ top: 0 });
  }, [activityScrollKey]);
  useEffect(() => {
    if (activity?.id && exerciseId) {
      const lastAttempt = activity.lastAttempt;
      setResult(
        lastAttempt && lastAttempt.exerciseId === exerciseId
          ? { ...lastAttempt, status: lastAttempt.status ?? 'graded' }
          : null,
      );
      setHint(null);
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key !== '?' &&
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
        if (
          result &&
          result.status !== 'invalid' &&
          (Number(result.correct) > 0 || !result.retryAllowed)
        ) {
          event.preventDefault();
          void queryClient.invalidateQueries({ queryKey: ['session', id] });
        }
      } else if (event.key === '?') {
        setShortcutsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [id, queryClient, result]);
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
  useEffect(() => {
    if (
      activity?.kind === 'learn' &&
      lesson?.knowledge_points?.length &&
      !activity.progress?.lessonRunnerContinued
    ) {
      return;
    }
    if (!activity) {
      tutorSidebar.clearContext();
      return;
    }
    const allowed = !['diagnostic', 'review', 'quick_check', 'assessment'].includes(activity.kind);
    tutorSidebar.setContext({
      conceptId: activity.conceptId ?? undefined,
      conceptTitle: activity.conceptTitle ?? undefined,
      activityId: activity.id,
      exerciseId: activity.exerciseIds.find(
        (candidate) => !(activity.progress?.completedExerciseIds ?? []).includes(candidate),
      ),
      page: 'session',
      pageLabel: activity.conceptTitle ?? undefined,
      allowed,
      enabled: sessionQuery.data.tutorEnabled,
    });
    return () => tutorSidebar.clearContext();
  }, [activity, lesson?.knowledge_points?.length, sessionQuery.data.tutorEnabled, tutorSidebar]);

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
      const data = await response.json();
      setResult({ ...data, exerciseId });
      if (response.ok && data.status !== 'invalid') {
        setHint(null);
      }
    } finally {
      setSubmittingAnswer(false);
    }
  };
  const continueNext = async () => {
    setContinuing(true);
    try {
      if (showingCompletedFinal && activity) {
        await apiFetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(activity.progress ?? {}),
            complete: true,
            finalQuestionContinued: true,
          }),
        });
      }
      await queryClient.invalidateQueries({ queryKey: ['session', id] });
    } finally {
      setContinuing(false);
    }
  };
  const continueLessonRunner = async (status: 'completed' | 'needs_retry') => {
    if (!activity) return;
    const finalQuestionPending =
      status === 'completed' &&
      !!lesson?.final &&
      !(activity.progress?.completedExerciseIds ?? []).includes(lesson.final);
    await apiFetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(activity.progress ?? {}),
        ...(!finalQuestionPending ? { complete: true } : {}),
        lessonRunnerContinued: true,
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

  if (!activity) {
    return (
      <section className="space-y-4">
        <h1 className="text-3xl font-semibold">Session complete</h1>
        <p className="text-muted-foreground">Your progress has been saved.</p>
        <Button type="button" onClick={endSession} loading={endingSession}>
          Finish session
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
  const activityPosition = Math.max(1, activities.findIndex((item) => item.id === activity.id) + 1);
  const activityLabel = sessionActivityLabel(activity.kind);
  const activityTitle =
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
    !result ||
    result.status === 'invalid' ||
    result.status === 'self_check_required' ||
    (Number(result?.correct) === 0 && result?.retryAllowed === true);
  const triesLeft = Math.max(0, 2 - Number(result?.attemptNo ?? 1));
  const helpActions =
    mode !== 'assessment' ? (
      <div className="flex flex-wrap gap-2">
        <HintLadder
          exerciseId={exerciseId ?? ''}
          activityId={activity.id}
          hintCount={exerciseQuery.data?.hintCount ?? 0}
          tutorEnabled={sessionQuery.data.tutorEnabled}
          onHint={setHint}
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
              result && result.status !== 'invalid'
                ? 'What would you like to know about this answer?'
                : undefined
            }
          />
        ) : null}
      </div>
    ) : null;
  const submitLabel =
    result?.status === 'self_check_required'
      ? 'Submit self-check'
      : Number(result?.correct) === 0 && result?.retryAllowed === true
        ? `Try again · ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left`
        : 'Submit answer';
  const currentResultOutcome =
    result &&
    result.exerciseId === exerciseId &&
    result.status !== 'invalid' &&
    result.status !== 'self_check_required'
      ? Number(result.correct) > 0
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
  if (
    activity.kind === 'learn' &&
    activity.conceptId &&
    lesson?.knowledge_points?.length &&
    !activity.progress?.lessonRunnerContinued
  ) {
    return (
      <LessonRunner
        conceptId={activity.conceptId}
        activityId={activity.id}
        title={activity.conceptTitle ?? activity.conceptId}
        activityLabel={activityLabel}
        activityPosition={activityPosition}
        activityCount={activities.length}
        lessonHref={lessonHref}
        tutorEnabled={sessionQuery.data.tutorEnabled}
        resumeRetry={activity.status !== 'completed'}
        onContinue={continueLessonRunner}
      />
    );
  }
  if (activity.kind === 'paper') {
    return (
      <section className="space-y-6">
        <SessionActivityHeader
          title="Paper reading"
          label="Paper"
          position={activityPosition}
          total={activities.length}
        />
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
      ...lesson.blocks.filter((block) => block.kind === 'objective'),
      ...lesson.blocks.filter((block) => block.kind !== 'objective' && block.kind !== 'summary'),
      ...lesson.blocks.filter((block) => block.kind === 'summary'),
    ];
    return (
      <section className="space-y-6">
        <SessionActivityHeader
          title={activityTitle}
          label={activityLabel}
          position={activityPosition}
          total={activities.length}
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
        position={activityPosition}
        total={activities.length}
        lessonHref={lessonHref}
      />
      {exerciseQuery.data ? (
        <Card data-testid="session-exercise">
          <CardContent className="space-y-5">
            <QuestionProgress states={questionStates} />
            <div data-testid="exercise-prompt">
              <Markdown>{exerciseQuery.data.prompt}</Markdown>
            </div>
            {shortcutsOpen ? (
              <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                Enter submits · h requests a hint · n or → continues · 1–9 selects an option · ?
                hides shortcuts
              </div>
            ) : null}
            <ExerciseForm
              key={`${activity.id}:${exerciseId}`}
              exercise={exerciseQuery.data}
              onSubmit={submitAnswer}
              explainStep={result?.status === 'self_check_required' ? 'self-check' : 'answer'}
              readOnlyAnswer={
                typeof result?.yourAnswer === 'string' ? result.yourAnswer : undefined
              }
              submittedAnswer={result?.yourAnswer}
              answerOptions={result?.answerOptions as AnswerOptions | undefined}
              locked={!canSubmitAnswer && result?.status !== 'invalid'}
              submitLabel={submitLabel}
              primaryAction={
                !canSubmitAnswer
                  ? { label: 'Continue', onClick: () => void continueNext(), loading: continuing }
                  : undefined
              }
              loading={submittingAnswer}
              actions={helpActions}
            />
            {result && result.status !== 'invalid' ? (
              <FeedbackPanel
                result={result}
                hideAnswerLines={['mc', 'debug'].includes(exerciseQuery.data.type)}
              />
            ) : null}
            {result?.status === 'invalid' ? (
              <Alert variant="destructive">
                <AlertDescription>
                  <Markdown inline>{String(result.feedback)}</Markdown>
                </AlertDescription>
              </Alert>
            ) : null}
            {hint?.text ? (
              <div className="rounded-lg bg-muted p-4 text-sm">
                <p className="font-medium">
                  {hint.revealedSolution ? 'Solution' : `Hint ${hint.level}`}
                </p>
                <Markdown>{hint.text}</Markdown>
              </div>
            ) : null}
            {hint?.tutorUnavailable ? (
              <p className="text-xs text-muted-foreground">Tutor unavailable right now.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : !exerciseId ? (
        <Card>
          <CardContent className="space-y-4">
            <h2 className="text-lg font-semibold capitalize">{activity.kind.replace('_', ' ')}</h2>
            <p className="max-w-[70ch] text-sm leading-6 text-muted-foreground">
              {activity.kind === 'lab'
                ? `Project ${activity.projectId ?? 'activity'} is ready to continue in your local workspace.`
                : activity.kind === 'teachback'
                  ? 'Summarize the main idea from memory before continuing.'
                  : activity.kind === 'reflect'
                    ? 'Take a moment to reflect on what you learned and what remains unclear.'
                    : 'No eligible exercise is available for this activity yet.'}
            </p>
            <Button type="button" onClick={completeActivity} loading={continuing}>
              Continue
            </Button>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

function sessionActivityLabel(kind: string) {
  const labels: Record<string, string> = {
    learn: 'Learn',
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
}: {
  exerciseId: string;
  activityId: string;
  onDone: () => void;
}) {
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { data: exercise } = useSuspenseQuery(exerciseQueryOptions(exerciseId));
  const submit = async (answer: unknown) => {
    setSubmitting(true);
    try {
      const response = await apiFetch('/api/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exerciseId, activityId, answer, mode: 'practice' }),
      });
      const data = await response.json();
      setResult(data);
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
            {result ? <FeedbackPanel result={result} /> : null}
            {!result || result.status === 'invalid' || result.retryAllowed ? (
              <ExerciseForm
                key={`${activityId}:${exerciseId}`}
                exercise={exercise}
                onSubmit={submit}
                loading={submitting}
              />
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
