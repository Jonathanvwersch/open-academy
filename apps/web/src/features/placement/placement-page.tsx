import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { PageLayoutSkeleton } from '../../components/page-layout-skeleton.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { courseQueryOptions, learnQueryOptions } from '../course/queries.js';
import { ExerciseForm } from '../exercises/exercise-form.js';
import { papersQueryOptions } from '../papers/queries.js';
import { todayQueryOptions } from '../sessions/queries.js';
import {
  placementAnswerMutationOptions,
  placementNextQueryOptions,
  startPlacementMutationOptions,
} from './queries.js';

async function invalidatePlacementProgress(queryClient: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: courseQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: learnQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: todayQueryOptions().queryKey }),
    queryClient.invalidateQueries({ queryKey: papersQueryOptions().queryKey }),
  ]);
}

export function PlacementPage({ initialRunId }: { initialRunId?: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const startRequested = useRef(false);
  const resultsNavigationRequested = useRef(false);
  const startPlacement = useMutation(startPlacementMutationOptions());
  const nextQuery = useQuery({
    ...placementNextQueryOptions(runId),
    enabled: runId !== null,
  });
  const answerPlacement = useMutation({
    ...placementAnswerMutationOptions(runId ?? ''),
    onSuccess: async () => {
      if (!runId) return;
      await queryClient.invalidateQueries({
        queryKey: placementNextQueryOptions(runId).queryKey,
      });
    },
  });

  const startRun = useCallback(() => {
    startRequested.current = true;
    startPlacement.mutate(undefined, {
      onSuccess: async ({ id }) => {
        setRunId(id);
        await invalidatePlacementProgress(queryClient);
        await navigate({ to: '/placement', search: { id }, replace: true });
      },
    });
  }, [navigate, queryClient, startPlacement.mutate]);

  useEffect(() => {
    if (initialRunId) {
      setRunId(initialRunId);
      return;
    }
    if (startRequested.current) return;
    startRun();
  }, [initialRunId, startRun]);

  const question = nextQuery.data;
  useEffect(() => {
    if (!runId || !question?.complete || resultsNavigationRequested.current) return;
    resultsNavigationRequested.current = true;
    void (async () => {
      await invalidatePlacementProgress(queryClient);
      await navigate({ to: '/placement/results', search: { id: runId }, replace: true });
    })();
  }, [navigate, queryClient, question?.complete, runId]);

  const submit = (answer: unknown, dontKnow = false) => {
    if (!runId || !question || question.complete || answerPlacement.isPending) return;
    answerPlacement.mutate({
      exerciseId: question.exercise.id,
      ...(dontKnow ? { dontKnow: true } : { answer }),
    });
  };

  const loadError = startPlacement.error ?? nextQuery.error;
  const retry = () => {
    if (runId) {
      void nextQuery.refetch();
      return;
    }
    startRequested.current = false;
    startPlacement.reset();
    startRun();
  };
  if (loadError && !question) {
    return (
      <section className="space-y-4">
        <h1 className="sr-only">Placement check</h1>
        <p role="alert">
          {loadError instanceof Error ? loadError.message : 'The placement check is unavailable.'}
        </p>
        <Button
          type="button"
          loading={startPlacement.isPending || nextQuery.isFetching}
          onClick={retry}
        >
          Try again
        </Button>
        <Button asChild variant="outline">
          <Link to="/course">Back to Courses</Link>
        </Button>
      </section>
    );
  }
  if (!runId || nextQuery.isPending || !question) return <PageLayoutSkeleton />;

  if (question.complete) return <PageLayoutSkeleton />;
  return (
    <section className="mx-auto w-full max-w-3xl space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">
        Placement check · {question.courseTitle}
      </h1>
      <p className="text-sm text-muted-foreground">
        Question {question.questionNumber} of up to {question.maxQuestions}
      </p>
      <Card data-exercise-container="">
        <CardContent className="space-y-5">
          <div data-testid="placement-prompt">
            <Markdown>{question.exercise.prompt}</Markdown>
          </div>
          <ExerciseForm
            key={question.exercise.id}
            exercise={question.exercise}
            onSubmit={(answer) => void submit(answer)}
            submitLabel="Submit"
            loading={answerPlacement.isPending}
            actions={
              <Button
                type="button"
                variant="outline"
                disabled={answerPlacement.isPending}
                onClick={() => void submit(undefined, true)}
              >
                I don&apos;t know
              </Button>
            }
          />
        </CardContent>
      </Card>
      {answerPlacement.error ? (
        <p role="alert" className="text-sm text-destructive">
          {answerPlacement.error.message}
        </p>
      ) : null}
    </section>
  );
}
