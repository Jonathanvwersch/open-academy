import type { QuizAnswer, QuizPayload } from '@open-academy/engine/api';
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent, CardHeader } from '../../components/ui/card.js';
import { ExerciseForm } from '../exercises/exercise-form.js';
import { postQuiz, quizQueryOptions } from './queries.js';
import { QuizResult } from './quiz-result.js';

const route = getRouteApi('/quizzes/$id');

function Countdown({
  deadline,
  serverNow,
  onExpire,
}: {
  deadline: string;
  serverNow: string;
  onExpire: () => void;
}) {
  const initial = Date.parse(deadline) - Date.parse(serverNow);
  const [remaining, setRemaining] = useState(initial);
  const expire = useRef(onExpire);
  useEffect(() => {
    expire.current = onExpire;
  }, [onExpire]);
  useEffect(() => {
    const end = performance.now() + initial;
    const tick = () => {
      const time = Math.max(0, end - performance.now());
      setRemaining(time);
      if (time === 0) expire.current();
      return time;
    };
    if (tick() === 0) return;
    const timer = window.setInterval(() => {
      if (tick() === 0) window.clearInterval(timer);
    }, 200);
    return () => window.clearInterval(timer);
  }, [initial]);
  const seconds = Math.ceil(remaining / 1000);
  return (
    <span role="timer" aria-label="Time remaining" className="tabular-nums">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

export function QuizPage() {
  const { id } = route.useParams();
  const search = route.useSearch();
  const client = useQueryClient();
  const navigate = useNavigate();
  const query = useSuspenseQuery({ ...quizQueryOptions(id), staleTime: 0 });
  const quiz = query.data;
  const session = quiz.sessionId ?? search.session;
  const [localExpired, setLocalExpired] = useState(false);
  const apply = (next: QuizPayload) =>
    client.setQueryData(quizQueryOptions(next.id).queryKey, next);
  const answer = useMutation({
    mutationFn: (input: QuizAnswer) => postQuiz<QuizPayload>(`${id}/answer`, input),
    onSuccess: apply,
    onError: async () => {
      await query.refetch();
    },
  });
  const finalize = useMutation({
    mutationFn: () => postQuiz<QuizPayload>(`${id}/finalize`),
    onSuccess: (next) => {
      apply(next);
      void client.invalidateQueries({ queryKey: ['session'] });
      void client.invalidateQueries({ queryKey: ['today'] });
      void client.invalidateQueries({ queryKey: ['learn'] });
    },
  });
  const { mutate: finish, status: finishStatus } = finalize;
  const canFinalize = (quiz.expired || localExpired || !quiz.question) && !quiz.result;
  useEffect(() => {
    if (canFinalize && !answer.isPending && finishStatus === 'idle') finish();
  }, [canFinalize, answer.isPending, finish, finishStatus]);
  const followUps = useMutation({
    mutationFn: () => postQuiz<{ sessionId: string }>(`${id}/follow-ups`),
    onSuccess: ({ sessionId }) => navigate({ to: '/session/$id', params: { id: sessionId } }),
  });
  const retake = useMutation({
    mutationFn: () => postQuiz<QuizPayload>(`${id}/retake`),
    onSuccess: (next) => {
      apply(next);
      return navigate({ to: '/quizzes/$id', params: { id: next.id }, search: { session } });
    },
  });
  const error = answer.error ?? finalize.error ?? followUps.error ?? retake.error;
  const expired = localExpired || quiz.expired;
  return (
    <section className="mx-auto w-full max-w-2xl space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <h1 className="font-semibold">
            {quiz.result
              ? quiz.retake
                ? 'Retake results'
                : 'Quiz results'
              : quiz.retake
                ? 'Quiz retake'
                : 'Timed quiz'}
          </h1>
          {!quiz.result && (
            <Countdown
              deadline={quiz.deadline}
              serverNow={quiz.serverNow}
              onExpire={() => setLocalExpired(true)}
            />
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {quiz.result ? (
            <QuizResult
              result={quiz.result}
              totalItems={quiz.totalItems}
              retake={quiz.retake}
              session={session}
              onReview={() => followUps.mutate()}
              reviewPending={followUps.isPending}
              onRetake={() => retake.mutate()}
              retakePending={retake.isPending}
            />
          ) : quiz.question && !expired ? (
            <>
              <p className="text-sm text-muted-foreground">
                Question {quiz.question.number} of {quiz.totalItems}
              </p>
              <div data-testid="quiz-prompt">
                <Markdown>{quiz.question.exercise.prompt}</Markdown>
              </div>
              <ExerciseForm
                key={`${quiz.question.position}:${quiz.question.exercise.id}`}
                exercise={quiz.question.exercise}
                loading={answer.isPending}
                onSubmit={(value) => {
                  if (!quiz.question || answer.isPending) return;
                  answer.mutate({
                    position: quiz.question.position,
                    questionId: quiz.question.exercise.id,
                    answer: value,
                  });
                }}
              />
            </>
          ) : (
            <p role="status">
              {expired ? 'Time is up. Calculating results…' : 'Calculating results…'}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error.message}
            </p>
          )}
          {finalize.isError && <Button onClick={() => finalize.mutate()}>Try again</Button>}
        </CardContent>
      </Card>
    </section>
  );
}
