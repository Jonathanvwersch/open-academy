import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Markdown } from '../../components/markdown.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { exerciseQueryOptions } from '../exercises/queries.js';
import {
  activeSessionQueryOptions,
  sessionQueryOptions,
  todayQueryOptions,
} from '../sessions/queries.js';
import { useTutorSidebar } from '../tutor/tutor-sidebar.js';
import { LessonBlock } from './lesson-block.js';
import { lessonReviewQueryOptions, lessonRunQueryOptions } from './queries.js';

const Route = getRouteApi('/lessons/$conceptId');
export function LessonReviewPage() {
  const { conceptId } = Route.useParams();
  const { from } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const reviewQuery = useSuspenseQuery(lessonReviewQueryOptions(conceptId));
  // Observe newer answers already in the cache without fetching the full run for a read-only page.
  const cachedRun = useQuery({ ...lessonRunQueryOptions(conceptId), enabled: false });
  const { lesson, checkAnswers, conceptTitle } = reviewQuery.data;
  const runStatus =
    cachedRun.dataUpdatedAt > reviewQuery.dataUpdatedAt
      ? (cachedRun.data?.run?.status ?? null)
      : reviewQuery.data.runStatus;
  const runQuery = useQuery({
    ...lessonRunQueryOptions(conceptId),
    enabled: runStatus === 'quiz',
  });
  const tutorSidebar = useTutorSidebar();
  const [startingQuiz, setStartingQuiz] = useState(false);
  const [quizStartError, setQuizStartError] = useState('');
  const finalBlock = lesson.blocks.find(
    (block) => block.kind === 'check' && block.exercise === lesson.final,
  );
  useEffect(() => {
    tutorSidebar.setContext({
      conceptId,
      conceptTitle,
      page: 'lesson',
      pageLabel: `${conceptTitle} · full lesson`,
      allowed: true,
      enabled: false,
    });
    return () => tutorSidebar.clearContext();
  }, [conceptId, conceptTitle, tutorSidebar]);
  const openQuiz = async () => {
    setStartingQuiz(true);
    setQuizStartError('');
    try {
      const activeSession = await queryClient.fetchQuery({
        ...activeSessionQueryOptions(),
        staleTime: 0,
      });
      const activeLesson = activeSession?.activities.find(
        (activity) =>
          activity.kind === 'learn' &&
          activity.conceptId === conceptId &&
          (activity.status === 'in_progress' || activity.status === 'planned'),
      );
      if (activeSession && activeLesson) {
        const session = await queryClient.fetchQuery({
          ...sessionQueryOptions(activeSession.id),
          staleTime: 0,
        });
        const lessonActivity = session.activities.find(
          (activity) =>
            activity.kind === 'learn' &&
            activity.conceptId === conceptId &&
            (activity.status === 'in_progress' || activity.status === 'planned'),
        );
        if (lessonActivity) {
          await navigate({
            to: '/session/$id',
            params: { id: activeSession.id },
            search: { activity: lessonActivity.id },
          });
          return;
        }
      }

      const today = await queryClient.fetchQuery({ ...todayQueryOptions(), staleTime: 0 });
      const response = await apiFetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ focusConceptId: conceptId, kind: today.sessionKind }),
      });
      const session = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !session.id) {
        throw new Error(session.error ?? 'Could not start a session for this quiz.');
      }
      await navigate({ to: '/session/$id', params: { id: session.id } });
    } catch (cause) {
      setQuizStartError(cause instanceof Error ? cause.message : 'Could not open the lesson quiz.');
    } finally {
      setStartingQuiz(false);
    }
  };

  return (
    <section className="space-y-6">
      {from ? (
        <Button asChild variant="link" className="px-0">
          <Link to="/session/$id" params={{ id: from }}>
            ← Back to session
          </Link>
        </Button>
      ) : null}
      <h1 className="text-3xl font-semibold">{conceptTitle}</h1>
      {runStatus === 'completed' ? (
        <p className="text-sm text-muted-foreground">Quiz passed</p>
      ) : runStatus === 'quiz' ? (
        runQuery.data?.run?.status === 'quiz' ? (
          <Card className="gap-0 border-amber-300 bg-amber-50" data-testid="lesson-quiz-entry">
            <CardContent className="space-y-4 text-amber-950">
              <p>
                {runQuery.data.run.quiz.last
                  ? `Quiz not passed yet · ${runQuery.data.run.quiz.last.correctCount} of ${runQuery.data.run.quiz.last.total}. Practise the steps you missed, then retake it.`
                  : 'Lesson steps done; quiz not taken yet.'}
              </p>
              <Button type="button" loading={startingQuiz} onClick={() => void openQuiz()}>
                {runQuery.data.run.quiz.last ? 'Go to the quiz' : 'Take the quiz'}
              </Button>
              {quizStartError ? (
                <p role="alert" className="text-sm text-destructive">
                  {quizStartError}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {runQuery.isError ? 'Could not load quiz details.' : 'Loading quiz details…'}
          </p>
        )
      ) : null}
      {lesson.knowledge_points?.length ? (
        <div className="space-y-5">
          {lesson.where_this_fits ? (
            <LessonBlock
              kind="fits"
              md={lesson.where_this_fits}
              prerequisites={lesson.prerequisites}
            />
          ) : null}
          {lesson.knowledge_points.map((point, index) => (
            <article key={point.id} className="space-y-4">
              <h2 className="text-xl font-semibold">
                {index + 1}. {point.title}
              </h2>
              <Markdown>{point.explain}</Markdown>
              <LessonBlock kind="worked" md={point.worked} />
            </article>
          ))}
          {finalBlock?.exercise ? (
            <LessonBlock key={finalBlock.exercise} kind="check" md={finalBlock.md}>
              <ReadOnlyCheck
                exerciseId={finalBlock.exercise}
                answer={checkAnswers[finalBlock.exercise] ?? ''}
              />
            </LessonBlock>
          ) : null}
          {lesson.blocks
            .filter((block) => block.kind === 'summary')
            .map((block) => (
              <LessonBlock key={`${block.kind}-${block.md}`} kind={block.kind} md={block.md} />
            ))}
        </div>
      ) : (
        <div className="space-y-5">
          {lesson.blocks
            .filter((block) => block.kind !== 'objective')
            .map((block) => (
              <LessonBlock
                key={block.exercise ?? `${block.kind}-${block.md}`}
                kind={block.kind}
                md={block.md}
              >
                {block.kind === 'check' && block.exercise ? (
                  <ReadOnlyCheck
                    exerciseId={block.exercise}
                    answer={checkAnswers[block.exercise] ?? ''}
                  />
                ) : null}
              </LessonBlock>
            ))}
        </div>
      )}
    </section>
  );
}

function ReadOnlyCheck({ exerciseId, answer }: { exerciseId: string; answer: string }) {
  const { data: exercise } = useSuspenseQuery(exerciseQueryOptions(exerciseId));
  const [open, setOpen] = useState(false);
  if (!exercise) return null;
  return (
    <div className="space-y-3">
      <Markdown>{exercise.prompt}</Markdown>
      <Button
        type="button"
        variant="link"
        className="px-0"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide answer' : 'Show answer'}
      </Button>
      {open ? (
        answer ? (
          <Markdown>{answer}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">No answer is available for this check.</p>
        )
      ) : null}
    </div>
  );
}
