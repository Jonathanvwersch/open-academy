import type { AnswerOptions, AttemptResponse } from '@academy/contracts/exercises';
import type { SessionActivity } from '@academy/contracts/sessions';
import { useQueries, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Markdown } from '../../components/markdown.js';
import { SessionSkeleton } from '../../components/skeletons.js';
import { ThinkingIndicator } from '../../components/thinking-indicator.js';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { readBrowserStorage, writeBrowserStorage } from '../../lib/browser-storage.js';
import { invalidateSidebarQueries, learnQueryOptions } from '../course/queries.js';
import { ExerciseForm } from '../exercises/exercise-form.js';
import { FeedbackPanel, FinalRetryNote, isFinalRetryResult } from '../exercises/feedback-panel.js';
import { HintLadder } from '../exercises/hint-ladder.js';
import { exerciseQueryOptions } from '../exercises/queries.js';
import { LessonBlock } from '../lessons/lesson-block.js';
import { LessonMarkdown, LessonRunner, LessonSteps } from '../lessons/lesson-runner.js';
import { lessonQueryOptions, lessonRunQueryOptions } from '../lessons/queries.js';
import { projectQueryOptions } from '../projects/queries.js';
import { TutorLauncher, useTutorSidebar } from '../tutor/tutor-sidebar.js';
import { sessionActivityLabel } from './activity-label.js';
import {
  selectSessionActivity,
  sessionActivityCandidates,
  usesLessonRunner,
} from './activity-selection.js';
import { InlineLessonCheck } from './inline-lesson-check.js';
import { PaperActivity } from './paper-activity.js';
import { sessionQueryOptions, todayQueryOptions } from './queries.js';
import { QuestionProgress, type QuestionState } from './question-progress.js';
import { SessionActivityHeader } from './session-activity-header.js';
import { SessionCompletion } from './session-completion.js';

const Route = getRouteApi('/session/$id');

async function saveActivityProgress(
  sessionId: string,
  activityId: string,
  progress: SessionActivity['progress'] & { complete?: boolean },
) {
  const response = await apiFetch(`/api/sessions/${sessionId}/activities/${activityId}/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(progress),
  }).catch(() => null);
  if (!response?.ok) throw new Error('Your progress was not saved. Please try again.');
}

export function SessionPage() {
  const navigate = useNavigate();
  const { id } = Route.useParams();
  const { activity: requestedActivityId } = Route.useSearch();
  const queryClient = useQueryClient();
  const tutorSidebar = useTutorSidebar();
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [progressError, setProgressError] = useState('');
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
  const [endSessionError, setEndSessionError] = useState('');
  const [markingLessonViewed, setMarkingLessonViewed] = useState(false);
  const [stepRecap, setStepRecap] = useState<{ activityId: string; pointId: string } | null>(null);
  const hintButton = useRef<HTMLButtonElement>(null);
  const questionFrame = useRef<HTMLDivElement>(null);
  const questionContent = useRef<HTMLDivElement>(null);
  const lastQuestionLayout = useRef<{ width: number; height: number; kind: string } | null>(null);
  const [questionLayout, setQuestionLayout] = useState<{
    key: string;
    width: number;
    height: number;
  } | null>(null);
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
  const lessonRunActivities = new Map<string, string>();
  for (const item of sessionActivityCandidates(activities, requestedActivityId)) {
    if (
      item.kind === 'learn' &&
      item.conceptId &&
      item.lessonAvailable &&
      !lessonRunActivities.has(item.conceptId)
    )
      lessonRunActivities.set(item.conceptId, item.id);
  }
  const lessonRunConceptIds = [...lessonRunActivities.keys()];
  const lessonRunQueries = useQueries({
    queries: lessonRunConceptIds.map((conceptId) => ({
      ...lessonRunQueryOptions(conceptId, lessonRunActivities.get(conceptId)),
      retry: false,
    })),
  });
  const lessonRunsByConcept = new Map(
    lessonRunConceptIds.map((conceptId, index) => [conceptId, lessonRunQueries[index]?.data?.run]),
  );
  const lessonRunsPending = lessonRunQueries.some((query) => query.isPending);
  const { activity, completedFinal, requestedCompletedActivity } = selectSessionActivity(
    activities,
    lessonRunsByConcept,
    requestedActivityId,
  );
  const showingLessonQuiz =
    activity?.kind === 'learn' &&
    Boolean(activity.conceptId) &&
    !activity.progress?.quizContinued &&
    lessonRunsByConcept.get(activity.conceptId ?? '')?.status === 'quiz';
  useEffect(() => {
    if (!activity) return;
    const nextActivity = activities
      .filter((item) => item.idx > activity.idx && item.status === 'planned')
      .sort((a, b) => a.idx - b.idx)[0];
    for (const item of [activity, nextActivity]) {
      if (!item) continue;
      for (const exerciseId of item.exerciseIds) {
        void queryClient.prefetchQuery(exerciseQueryOptions(exerciseId));
      }
    }
    if (nextActivity?.kind === 'learn' && nextActivity.lessonAvailable && nextActivity.conceptId) {
      void queryClient.prefetchQuery(lessonQueryOptions(nextActivity.conceptId));
      void queryClient.prefetchQuery(
        lessonRunQueryOptions(nextActivity.conceptId, nextActivity.id),
      );
    }
  }, [activities, activity, queryClient]);
  const showingRequestedCompletedActivity = Boolean(
    activity && activity.id === requestedCompletedActivity?.id && !showingLessonQuiz,
  );
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
  const recapPoint =
    stepRecap?.activityId === activity?.id &&
    activity?.kind === 'learn' &&
    lesson?.final === exerciseId &&
    lessonRunsByConcept
      .get(activity.conceptId ?? '')
      ?.points.some((point) => point.id === stepRecap?.pointId && point.status === 'passed')
      ? lesson?.knowledge_points?.find((point) => point.id === stepRecap?.pointId)
      : undefined;
  const lessonRunnerActive = usesLessonRunner(activity, lesson);
  const exerciseQuery = useQuery({
    ...exerciseQueryOptions(lessonRunnerActive ? null : (exerciseId ?? null)),
    throwOnError: true,
  });
  const questionLayoutKey = activity && exerciseId ? `${activity.id}:${exerciseId}` : '';
  useLayoutEffect(() => {
    const frame = questionFrame.current;
    if (!frame || !questionLayoutKey || lessonRunnerActive) return;
    const content =
      !exerciseQuery.isPending &&
      !currentResult &&
      !recapPoint &&
      !hints.length &&
      !submitError &&
      !tutorUnavailable
        ? questionContent.current
        : null;
    let active = true;
    const update = () => {
      if (!active || !frame.isConnected || frame.getBoundingClientRect().width <= 0) return;
      const width = Math.round(frame.getBoundingClientRect().width);
      const previous = lastQuestionLayout.current;
      setQuestionLayout((current) => {
        if (current?.key === questionLayoutKey && current.width === width) return current;
        return previous?.width === width && previous.kind === activity?.kind
          ? { key: questionLayoutKey, width, height: previous.height }
          : null;
      });
      // The minimum lives on the outer card, so its inner content remains an
      // intrinsic measurement. Never record feedback or carry an imposed floor forward.
      if (content && content.getBoundingClientRect().height > 0) {
        lastQuestionLayout.current = {
          width,
          height: content.getBoundingClientRect().height,
          kind: activity?.kind ?? '',
        };
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    if (content) observer.observe(content);
    void document.fonts.ready.then(update);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [
    activity?.kind,
    currentResult,
    exerciseQuery.isPending,
    hints.length,
    lessonRunnerActive,
    questionLayoutKey,
    recapPoint,
    submitError,
    tutorUnavailable,
  ]);
  const questionMinHeight =
    questionLayout?.key === questionLayoutKey ? questionLayout.height : undefined;
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
    if (elapsed > session.plannedMinutes * 1.3 && !readBrowserStorage('sessionStorage', key)) {
      writeBrowserStorage('sessionStorage', key, 'true');
      void apiFetch(`/api/sessions/${id}/replan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          remainingBudgetMinutes: Math.max(0, session.plannedMinutes - elapsed),
        }),
      })
        .then((response) => {
          if (!response.ok) throw new Error('Replan failed');
          return queryClient.invalidateQueries({ queryKey: ['session', id] });
        })
        .catch(() => writeBrowserStorage('sessionStorage', key, null));
    }
  }, [clock, id, queryClient, sessionQuery.data, timeAnchor]);
  useEffect(() => {
    if (lessonRunnerActive) return;
    if (!activity) {
      tutorSidebar.clearContext();
      return;
    }
    const allowed = !['review', 'quick_check', 'assessment'].includes(activity.kind);
    tutorSidebar.setContext({
      conceptId: activity.conceptId ?? undefined,
      conceptTitle: activity.conceptTitle ?? undefined,
      activityId: activity.id,
      exerciseId: recapPoint ? undefined : exerciseId,
      knowledgePointId: recapPoint?.id,
      questionLabel:
        activity.kind === 'learn' && lesson?.final === exerciseId
          ? 'Explain it'
          : exerciseId && activity.exerciseIds.length > 1
            ? `Question ${activity.exerciseIds.indexOf(exerciseId) + 1} of ${activity.exerciseIds.length}`
            : undefined,
      page: 'session',
      pageLabel: recapPoint
        ? `${activity.conceptTitle} · ${recapPoint.title}`
        : (activity.conceptTitle ?? undefined),
      allowed,
      enabled: sessionQuery.data.tutorEnabled,
    });
    return () => tutorSidebar.clearContext();
  }, [
    activity,
    exerciseId,
    lesson?.final,
    lessonRunnerActive,
    recapPoint,
    sessionQuery.data.tutorEnabled,
    tutorSidebar,
  ]);

  const markLessonViewed = async () => {
    if (!activity) return;
    setMarkingLessonViewed(true);
    setProgressError('');
    try {
      await saveActivityProgress(id, activity.id, {
        ...(activity.progress ?? {}),
        lessonViewed: true,
      });
      await queryClient.invalidateQueries({ queryKey: ['session', id] });
    } catch {
      setProgressError('Your progress was not saved. Please try again.');
    } finally {
      setMarkingLessonViewed(false);
    }
  };

  const completeActivity = async () => {
    if (!activity) return;
    setContinuing(true);
    setProgressError('');
    try {
      await saveActivityProgress(id, activity.id, {
        ...(activity.progress ?? {}),
        complete: true,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['session', id] }),
        invalidateSidebarQueries(queryClient),
      ]);
    } catch {
      setProgressError('Your progress was not saved. Please try again.');
    } finally {
      setContinuing(false);
    }
  };

  const submitAnswer = async (answer: unknown) => {
    if (!exerciseId || !activity) return;
    setSubmittingAnswer(true);
    setSubmitError('');
    const mode =
      activity.kind === 'quick_check'
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
      const data = (await response.json().catch(() => ({}))) as AttemptResponse;
      const { activityCompleted, ...attemptResult } = data;
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
        // Client-side lesson navigation must retain the same feedback a document reload restores.
        queryClient.setQueryData(sessionQueryOptions(id).queryKey, (session) =>
          session
            ? {
                ...session,
                activities: session.activities.map((item) =>
                  item.id === activity.id
                    ? { ...item, lastAttempt: { ...attemptResult, exerciseId } }
                    : item,
                ),
              }
            : session,
        );
        if (activityCompleted === true) {
          await invalidateSidebarQueries(queryClient);
        }
        setHints([]);
        setTutorUnavailable(false);
      }
    } catch {
      setSubmitError('Your answer was not saved. Check your connection and try again.');
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
    setProgressError('');
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
        await saveActivityProgress(id, freshActivity.id, {
          ...(freshActivity.progress ?? {}),
          finalQuestionContinued: true,
        });
        finalQuestionContinued = true;
      }
      if (finalQuestionContinued) {
        await queryClient.invalidateQueries({ queryKey: ['session', id] });
      }
    } catch {
      setProgressError('Could not continue. Please try again.');
    } finally {
      setContinuing(false);
    }
  }, [activity, currentResult, exerciseId, id, queryClient]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        recapPoint ||
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
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
  }, [continueNext, currentResult, recapPoint]);
  const continueLessonRunner = async (_status: 'quiz' | 'completed', stage: 'final' | 'done') => {
    if (!activity) return;
    const finalQuestionPending =
      stage === 'final' &&
      !!lesson?.final &&
      !(activity.progress?.completedExerciseIds ?? []).includes(lesson.final);
    await saveActivityProgress(id, activity.id, {
      ...(activity.progress ?? {}),
      lessonRunnerContinued: true,
      ...(finalQuestionPending ? {} : { finalQuestionContinued: true }),
      ...(stage === 'done' ? { complete: true, quizContinued: true } : {}),
    });
    await queryClient.invalidateQueries({ queryKey: ['session', id] });
  };

  const endSession = async () => {
    setEndingSession(true);
    setEndSessionError('');
    try {
      const response = await apiFetch(`/api/sessions/${id}/end`, { method: 'POST' });
      if (!response.ok) throw new Error('Could not finish session');
      await Promise.all([
        queryClient.fetchQuery({ ...learnQueryOptions(), staleTime: 0 }),
        queryClient.invalidateQueries({
          queryKey: todayQueryOptions().queryKey,
          refetchType: 'none',
        }),
        invalidateSidebarQueries(queryClient),
      ]);
      await navigate({ to: '/' });
    } catch {
      setEndSessionError('Could not return Home. Please try again.');
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
        error={endSessionError}
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
      : activity.kind === 'quick_check'
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
          : ['quick_check', 'assessment'].includes(activity.kind)
            ? 'Quiz'
            : sessionActivityLabel(activity.kind));
  const lessonLink =
    activity.conceptId && activity.lessonAvailable
      ? { conceptId: activity.conceptId, from: id }
      : undefined;
  const canSubmitAnswer =
    !currentResult ||
    currentResult.status === 'invalid' ||
    currentResult.status === 'self_check_required' ||
    (currentResult.followUp === true && currentResult.retryAllowed === true) ||
    (Number(currentResult.correct) === 0 && currentResult.retryAllowed === true);
  const isExplainQuestion = activity.kind === 'learn' && lesson?.final === exerciseId;
  const explainRun =
    isExplainQuestion && activity.conceptId
      ? lessonRunsByConcept.get(activity.conceptId)
      : undefined;
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
        key={activity.id}
        conceptId={activity.conceptId}
        activityId={activity.id}
        sessionId={id}
        title={activity.conceptTitle ?? activity.conceptId}
        activityLabel={activityLabel}
        lessonLink={lessonLink}
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
            await saveActivityProgress(id, activity.id, { complete: true });
            await Promise.all([
              queryClient.invalidateQueries({ queryKey: ['session', id] }),
              invalidateSidebarQueries(queryClient),
            ]);
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
          lessonLink={lessonLink}
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
        {progressError ? (
          <p role="alert" className="text-sm text-destructive">
            {progressError}
          </p>
        ) : null}
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
        lessonLink={isExplainQuestion && canSubmitAnswer ? undefined : lessonLink}
        subtitle={
          recapPoint?.title ?? (isExplainQuestion ? 'Explain it in your own words' : undefined)
        }
      />
      {explainRun ? (
        <LessonSteps
          state={explainRun}
          viewingPastStep={Boolean(recapPoint)}
          viewingPointId={recapPoint?.id ?? null}
          currentPointId={explainRun.currentPointId ?? undefined}
          viewStep={(pointId) => {
            if (
              !explainRun.points.some((point) => point.id === pointId && point.status === 'passed')
            )
              return;
            setStepRecap({ activityId: activity.id, pointId });
            window.scrollTo({ top: 0 });
          }}
          returnToCurrentStep={() => {
            setStepRecap(null);
            window.scrollTo({ top: 0 });
          }}
          explain="current"
        />
      ) : null}
      {recapPoint ? (
        <section data-testid="explain-step-recap" className="space-y-4">
          <Button
            type="button"
            onClick={() => {
              setStepRecap(null);
              window.scrollTo({ top: 0 });
            }}
          >
            Back to Explain it
          </Button>
          <div data-testid="lesson-step-content" className="space-y-4">
            <LessonMarkdown>{recapPoint.explain}</LessonMarkdown>
            <LessonBlock kind="worked" md={recapPoint.worked} />
          </div>
        </section>
      ) : null}
      <div ref={questionFrame} hidden={Boolean(recapPoint)} className="space-y-6">
        {progressError ? (
          <p role="alert" className="text-sm text-destructive">
            {progressError}
          </p>
        ) : null}
        {exerciseId && exerciseQuery.isPending ? (
          <Card
            data-testid="question-loading"
            role="status"
            aria-label="Loading question"
            aria-busy="true"
            style={{ minHeight: questionMinHeight }}
          >
            <CardContent className="flex flex-1 flex-col gap-5">
              <QuestionProgress states={questionStates} />
              <div className="flex flex-1 items-center justify-center py-6">
                <ThinkingIndicator />
              </div>
            </CardContent>
          </Card>
        ) : exerciseQuery.data ? (
          <Card
            data-testid="session-exercise"
            data-exercise-container=""
            style={{ minHeight: questionMinHeight }}
          >
            <CardContent ref={questionContent} className="space-y-5">
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
                  typeof currentResult?.yourAnswer === 'string'
                    ? currentResult.yourAnswer
                    : undefined
                }
                submittedAnswer={currentResult?.yourAnswer}
                answerOptions={currentResult?.answerOptions as AnswerOptions | undefined}
                locked={!canSubmitAnswer && currentResult?.status !== 'invalid'}
                submitLabel={submitLabel}
                primaryAction={
                  !canSubmitAnswer
                    ? {
                        label: 'Continue',
                        onClick: () => void continueNext(),
                        loading: continuing,
                        disabled: Boolean(recapPoint),
                      }
                    : undefined
                }
                loading={submittingAnswer}
                disabled={Boolean(recapPoint)}
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
              {isFinalRetryResult(currentResult) ? <FinalRetryNote /> : null}
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
      </div>
    </section>
  );
}
