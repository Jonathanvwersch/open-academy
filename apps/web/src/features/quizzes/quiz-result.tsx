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
  const reviewed = result.topics.filter((topic) => topic.reviewed).length;
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
      ) : result.retake.eligible ? (
        <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
          <div className="space-y-1">
            <h2 className="font-medium">Reviews done. Your retake is unlocked.</h2>
            <p className="text-muted-foreground text-sm">
              You reviewed {reviewed === 1 ? 'the topic' : `all ${reviewed} topics`} from this quiz.
              You can now retake the quiz once, with new questions on the same topics. It is
              optional and gives no XP.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button disabled={retakePending} onClick={onRetake}>
              Retake quiz now
            </Button>
            <Button variant="link" className="px-0" asChild>
              {session ? (
                <Link to="/session/$id" params={{ id: session }}>
                  Skip the retake and continue session
                </Link>
              ) : (
                <Link to="/">Skip the retake and go Home</Link>
              )}
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            If you skip it, nothing is lost. These topics stay in your normal reviews.
          </p>
        </div>
      ) : result.retake.id ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={retakePending} onClick={onRetake}>
            View retake
          </Button>
          <Button variant="outline" asChild>
            {leave}
          </Button>
        </div>
      ) : (
        <Button asChild>{leave}</Button>
      )}
    </div>
  );
}
