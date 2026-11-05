import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button } from '@/ui/button.js';
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
    <RouteLoadError
      message="This lesson could not be loaded."
      className="text-sm text-destructive"
    />
  ),
  component: LessonReviewPage,
});

function LessonReviewPage() {
  const { conceptId } = Route.useParams();
  const { from } = Route.useSearch();
  const { data } = useSuspenseQuery(lessonReviewQueryOptions(conceptId));
  const { lesson, checkAnswers, conceptTitle } = data;
  const finalBlock = lesson.blocks.find(
    (block) => block.kind === 'check' && block.exercise === lesson.final,
  );
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      {from ? (
        <Button asChild variant="link" className="px-0">
          <a href={`/session/${encodeURIComponent(from)}`}>← Back to session</a>
        </Button>
      ) : null}
      <h1 className="text-3xl font-semibold">{conceptTitle}</h1>
      {lesson.knowledge_points?.length ? (
        <div className="space-y-5">
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
          <p className="text-sm text-neutral-600">No answer is available for this check.</p>
        )
      ) : null}
    </div>
  );
}
