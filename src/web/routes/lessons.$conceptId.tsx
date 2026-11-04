import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { LessonBlock, Markdown } from '../components.js';
import { exerciseQueryOptions, lessonReviewQueryOptions } from '../queries.js';
import { RouteLoadError } from '../route-error.js';

export const Route = createFileRoute('/lessons/$conceptId')({
  validateSearch: (search: Record<string, unknown>) => ({
    from: typeof search.from === 'string' ? search.from : undefined,
  }),
  loader: async ({ context, params }) => {
    const payload = await context.queryClient.ensureQueryData(
      lessonReviewQueryOptions(params.conceptId),
    );
    await Promise.all(
      payload.lesson.blocks.flatMap((block) =>
        block.exercise
          ? [context.queryClient.ensureQueryData(exerciseQueryOptions(block.exercise))]
          : [],
      ),
    );
  },
  errorComponent: () => (
    <RouteLoadError message="This lesson could not be loaded." className="text-sm text-red-700" />
  ),
  component: LessonReviewPage,
});

function LessonReviewPage() {
  const { conceptId } = Route.useParams();
  const { from } = Route.useSearch();
  const { data } = useSuspenseQuery(lessonReviewQueryOptions(conceptId));
  const { lesson, checkAnswers, conceptTitle } = data;
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      {from ? (
        <a
          href={`/session/${encodeURIComponent(from)}`}
          className="inline-block text-sm font-medium text-blue-700 underline"
        >
          ← Back to session
        </a>
      ) : null}
      <h1 className="text-3xl font-semibold">{conceptTitle}</h1>
      {lesson.knowledge_points?.length ? (
        <div className="space-y-5">
          {lesson.knowledge_points.map((point, index) => (
            <article
              key={point.id}
              className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5"
            >
              <h2 className="text-xl font-semibold">
                {index + 1}. {point.title}
              </h2>
              <Markdown>{point.explain}</Markdown>
              <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">
                  Worked example
                </p>
                <Markdown>{point.worked}</Markdown>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {lesson.blocks.map((block) => (
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
      <button
        type="button"
        className="text-sm font-medium text-blue-700 underline"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? 'Hide answer' : 'Show answer'}
      </button>
      {open ? (
        answer ? (
          <Markdown>{answer}</Markdown>
        ) : (
          <p className="text-sm text-neutral-600">No answer is available for this check.</p>
        )
      ) : null}
    </div>
  );
}
