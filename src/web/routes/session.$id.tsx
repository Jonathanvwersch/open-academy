import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, AlertDescription } from '@/ui/alert.js';
import { Button } from '@/ui/button.js';
import { Card, CardContent } from '@/ui/card.js';
import { ExerciseForm, FeedbackPanel, HintLadder, LessonBlock, Markdown } from '../components';
import { LessonRunner } from '../lesson/LessonRunner.js';
import {
  exerciseQueryOptions,
  type LessonRunPayload,
  lessonQueryOptions,
  lessonRunQueryOptions,
  sessionQueryOptions,
} from '../queries.js';
import { RouteLoadError } from '../route-error.js';
import { SessionActivityHeader } from '../session/SessionActivityHeader.js';
import { TutorLauncher, useTutorSidebar } from '../tutor/TutorSidebar.js';

export const Route = createFileRoute('/session/$id')({
  loader: async ({ context, params }) => {
    const session = await context.queryClient.ensureQueryData(sessionQueryOptions(params.id));
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
  const activity = completedLesson ?? activeActivity;
  useEffect(() => {
    const allowed =
      !!activity && !['diagnostic', 'review', 'quick_check', 'assessment'].includes(activity.kind);
    tutorSidebar.setContext({
      conceptId: activity?.conceptId,
      conceptTitle: activity?.conceptTitle,
      activityId: activity?.id,
      exerciseId: activity?.exerciseIds.find(
        (candidate) => !(activity.progress?.completedExerciseIds ?? []).includes(candidate),
      ),
      allowed,
      enabled: sessionQuery.data.tutorEnabled,
    });
  }, [activity, sessionQuery.data.tutorEnabled, tutorSidebar]);
  const exerciseId = activity?.exerciseIds.find(
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
          ? { ...lastAttempt, status: 'graded' }
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
      void fetch(`/api/sessions/${id}/replan`, {
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

  const markLessonViewed = async () => {
    if (!activity) return;
    await fetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(activity.progress ?? {}), lessonViewed: true }),
    });
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };

  const completeActivity = async () => {
    if (!activity) return;
    await fetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(activity.progress ?? {}), complete: true }),
    });
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };

  const submitAnswer = async (answer: unknown) => {
    if (!exerciseId || !activity) return;
    const mode =
      activity.kind === 'quick_check' || activity.kind === 'diagnostic'
        ? 'assessment'
        : activity.kind === 'review'
          ? 'review'
          : 'practice';
    const response = await fetch('/api/attempts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exerciseId, activityId: activity.id, answer, mode }),
    });
    const data = await response.json();
    setResult(data);
    if (response.ok && data.status !== 'invalid') {
      setHint(null);
    }
  };
  const continueNext = async () => {
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };
  const continueLessonRunner = async () => {
    if (!activity) return;
    await fetch(`/api/sessions/${id}/activities/${activity.id}/progress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(activity.progress ?? {}),
        complete: true,
        lessonRunnerContinued: true,
      }),
    });
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };

  const endSession = async () => {
    await fetch(`/api/sessions/${id}/end`, { method: 'POST' });
    window.location.href = '/';
  };

  if (!activity) {
    return (
      <section className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-3xl font-semibold">Session complete</h1>
        <p className="text-neutral-600">Your progress has been saved.</p>
        <Button type="button" onClick={endSession}>
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
  const lesson = lessonQuery.data;
  const activityPosition = Math.max(1, activities.findIndex((item) => item.id === activity.id) + 1);
  const activityLabel = sessionActivityLabel(activity.kind);
  const activityTitle =
    activity.conceptTitle ??
    (activity.kind === 'review'
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
  const canAskForHelp = !result || result.status === 'invalid' || result.retryAllowed === true;
  const triesLeft = Math.max(0, 2 - Number(result?.attemptNo ?? 1));
  const submitLabel =
    result?.status === 'self_check_required'
      ? 'Submit self-check'
      : Number(result?.correct) === 0 && result?.retryAllowed === true
        ? `Try again · ${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left`
        : 'Submit answer';
  if (activity.kind === 'learn' && activity.conceptId && lesson?.knowledge_points?.length) {
    return (
      <LessonRunner
        conceptId={activity.conceptId}
        activityId={activity.id}
        title={activity.conceptTitle ?? activity.conceptId}
        activityLabel={activityLabel}
        activityPosition={activityPosition}
        activityCount={activities.length}
        lessonHref={lessonHref}
        mode={mode}
        tutorEnabled={sessionQuery.data.tutorEnabled}
        resumeRetry={activity.status !== 'completed'}
        onContinue={() => void continueLessonRunner()}
      />
    );
  }
  if (activity.kind === 'learn' && !activity.progress?.lessonViewed && lesson?.blocks.length) {
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
      <section className="mx-auto max-w-3xl space-y-6">
        <SessionActivityHeader
          title={activityTitle}
          label={activityLabel}
          position={activityPosition}
          total={activities.length}
          mode={mode}
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
        <Button type="button" onClick={markLessonViewed} disabled={checksPending}>
          Continue to practice
        </Button>
        {checksPending ? (
          <p className="text-sm text-neutral-500">Answer or skip the check above to continue.</p>
        ) : null}
      </section>
    );
  }
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <SessionActivityHeader
        title={activityTitle}
        label={activityLabel}
        position={activityPosition}
        total={activities.length}
        mode={mode}
        lessonHref={lessonHref}
      />
      {exerciseQuery.data ? (
        <Card data-testid="session-exercise">
          <CardContent className="space-y-5 p-6">
            <div data-testid="exercise-prompt">
              <Markdown>{exerciseQuery.data.prompt}</Markdown>
            </div>
            {shortcutsOpen ? (
              <div className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
                Enter submits · h requests a hint · n or → continues · 1–9 selects an option · ?
                hides shortcuts
              </div>
            ) : null}
            {result && result.status !== 'invalid' ? <FeedbackPanel result={result} /> : null}
            {result?.status === 'invalid' ? (
              <Alert variant="destructive">
                <AlertDescription>{String(result.feedback)}</AlertDescription>
              </Alert>
            ) : null}
            {hint?.text ? (
              <div className="rounded-lg bg-neutral-100 p-4 text-sm">
                <p className="font-medium">
                  {hint.revealedSolution ? 'Solution' : `Hint ${hint.level}`}
                </p>
                <Markdown>{hint.text}</Markdown>
              </div>
            ) : null}
            {hint?.tutorUnavailable ? (
              <p className="text-xs text-neutral-500">Tutor unavailable right now.</p>
            ) : null}
            {canSubmitAnswer ? (
              <ExerciseForm
                key={`${activity.id}:${exerciseId}`}
                exercise={exerciseQuery.data}
                onSubmit={submitAnswer}
                explainStep={result?.status === 'self_check_required' ? 'self-check' : 'answer'}
                readOnlyAnswer={
                  typeof result?.yourAnswer === 'string' ? result.yourAnswer : undefined
                }
                submitLabel={submitLabel}
              />
            ) : (
              <Button type="button" onClick={continueNext}>
                Continue
              </Button>
            )}
            {canAskForHelp ? (
              <div className="flex flex-wrap gap-2">
                {mode !== 'assessment' ? (
                  <HintLadder
                    exerciseId={exerciseId ?? ''}
                    activityId={activity.id}
                    hintCount={exerciseQuery.data.hintCount}
                    tutorEnabled={sessionQuery.data.tutorEnabled}
                    onHint={setHint}
                    mode={mode === 'review' ? 'review' : 'practice'}
                    buttonRef={hintButton}
                  />
                ) : null}
                {mode === 'practice' && exerciseId && sessionQuery.data.tutorEnabled ? (
                  <TutorLauncher
                    context={{
                      conceptId: activity.conceptId,
                      conceptTitle: activity.conceptTitle,
                      activityId: activity.id,
                      exerciseId,
                      allowed: true,
                      enabled: sessionQuery.data.tutorEnabled,
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : !exerciseId ? (
        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 className="text-lg font-semibold capitalize">{activity.kind.replace('_', ' ')}</h2>
            <p className="max-w-[70ch] text-sm leading-6 text-neutral-600">
              {activity.kind === 'lab'
                ? `Project ${activity.projectId ?? 'activity'} is ready to continue in your local workspace.`
                : activity.kind === 'teachback'
                  ? 'Summarize the main idea from memory before continuing.'
                  : activity.kind === 'reflect'
                    ? 'Take a moment to reflect on what you learned and what remains unclear.'
                    : 'No eligible exercise is available for this activity yet.'}
            </p>
            <Button type="button" onClick={completeActivity}>
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
  };
  return labels[kind] ?? kind.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
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
  const { data: exercise } = useSuspenseQuery(exerciseQueryOptions(exerciseId));
  const submit = async (answer: unknown) => {
    const response = await fetch('/api/attempts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ exerciseId, activityId, answer, mode: 'practice' }),
    });
    const data = await response.json();
    setResult(data);
    if (response.ok && data.status !== 'invalid') onDone();
  };
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        {exercise ? (
          <>
            <Markdown>{exercise.prompt}</Markdown>
            {result ? <FeedbackPanel result={result} /> : null}
            {!result || result.status === 'invalid' || result.retryAllowed ? (
              <ExerciseForm
                key={`${activityId}:${exerciseId}`}
                exercise={exercise}
                onSubmit={submit}
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
