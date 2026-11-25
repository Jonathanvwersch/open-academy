import type { QuizPayload } from '@academy/contracts/quizzes';
import { Link } from '@tanstack/react-router';
import { Button } from '../../components/ui/button.js';

type Result = NonNullable<QuizPayload['result']>;

export function QuizResult({
  result,
  totalItems,
  retake,
  session,
  onReview,
  reviewPending,
  onRetake,
  retakePending,
}: {
  result: Result;
  totalItems: number;
  retake: boolean;
  session?: string;
  onReview: () => void;
  reviewPending: boolean;
  onRetake: () => void;
  retakePending: boolean;
}) {
  const correct = Math.round(result.score * totalItems);
  const toReview = result.topics.filter((topic) => !topic.reviewed);
  const canRetake = result.retake.eligible || Boolean(result.retake.id);
  const retakeLater = !retake && !canRetake && result.topics.some((topic) => topic.missed);
  const leave = session ? (
    <Link to="/session/$id" params={{ id: session }}>
      Continue session
    </Link>
  ) : (
    <Link to="/">Back to Home</Link>
  );

  return (
    <div className="space-y-6">
      <p className="flex items-baseline gap-3">
        <span className="font-semibold text-3xl tabular-nums">
          {correct} of {totalItems} correct
        </span>
        {!retake && <span className="text-muted-foreground">+{result.xpAwarded} XP</span>}
      </p>

      {toReview.length > 0 ? (
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="space-y-1">
            <h2 className="font-medium">
              Next: review{' '}
              {toReview.length === 1 ? 'this topic' : `these ${toReview.length} topics`}
            </h2>
            <p className="text-muted-foreground text-sm">
              {retakeLater
                ? 'Then you can retake the quiz once, if you want.'
                : 'A short review of what you missed or answered slowly.'}
            </p>
          </div>
          <ul className="divide-y rounded-md border bg-card">
            {toReview.map((topic) => (
              <li
                key={topic.conceptId}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <span>{topic.title}</span>
                <span className="shrink-0 text-muted-foreground text-sm">
                  {topic.missed ? 'Incorrect' : 'Correct, but slow'}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button disabled={reviewPending} onClick={onReview}>
              Review now
            </Button>
            <Button variant="link" className="px-0" asChild>
              {session ? (
                <Link to="/session/$id" params={{ id: session }}>
                  Later (keeps them in your reviews)
                </Link>
              ) : (
                <Link to="/">Later (keeps them in your reviews)</Link>
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {canRetake && (
            <p className="text-muted-foreground text-sm">
              {result.retake.id
                ? 'You have started the retake.'
                : 'Reviews done. You can retake the quiz once with new questions. It is optional.'}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button asChild>{leave}</Button>
            {canRetake && (
              <Button variant="outline" disabled={retakePending} onClick={onRetake}>
                {result.retake.id ? 'View retake' : 'Retake quiz'}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
