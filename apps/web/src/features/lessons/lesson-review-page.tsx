import { useSuspenseQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { Button } from '../../components/ui/button.js';
import { exerciseQueryOptions } from '../exercises/queries.js';
import { useTutorSidebar } from '../tutor/tutor-sidebar.js';
import { LessonBlock } from './lesson-block.js';
import { lessonReviewQueryOptions, lessonRunQueryOptions } from './queries.js';

const Route = getRouteApi('/lessons/$conceptId');
export function LessonReviewPage() {
  const { conceptId } = Route.useParams();
  const { from } = Route.useSearch();
  const { data } = useSuspenseQuery(lessonReviewQueryOptions(conceptId));
  const { data: runData } = useSuspenseQuery(lessonRunQueryOptions(conceptId));
  const { lesson, checkAnswers, conceptTitle } = data;
  const tutorSidebar = useTutorSidebar();
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
  return (
    <section className="space-y-6">
      {from ? (
        <Button asChild variant="link" className="px-0">
          <a href={`/session/${encodeURIComponent(from)}`}>← Back to session</a>
        </Button>
      ) : null}
      <h1 className="text-3xl font-semibold">{conceptTitle}</h1>
      {runData.run?.status === 'completed' ? (
        <p className="text-sm text-muted-foreground">Quiz passed</p>
      ) : runData.run?.status === 'quiz' ? (
        <p className="text-sm text-muted-foreground">Quiz not passed yet</p>
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
