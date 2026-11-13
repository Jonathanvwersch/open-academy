import type { QuizReviewPayload } from '@academy/contracts/lessons';
import { Check, X } from 'lucide-react';
import { Markdown } from '../../components/markdown.js';
import { Button } from '../../components/ui/button.js';
import { Card, CardContent } from '../../components/ui/card.js';
export function QuizReview({
  quizReview,
  onClose,
}: {
  quizReview: QuizReviewPayload;
  onClose: () => void;
}) {
  return (
    <Card data-testid="lesson-quiz-review">
      <CardContent className="space-y-5">
        <h2 className="text-xl font-semibold">See answers</h2>
        <Button type="button" variant="outline" onClick={onClose}>
          Back to results
        </Button>
        {quizReview.items.map((item, index) => (
          <article key={item.id} className="space-y-3 border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold">Question {index + 1}</h3>
              {item.correct != null && item.correct >= 1 ? (
                <span
                  data-testid="quiz-review-mark"
                  data-correct="true"
                  className="flex items-center gap-1 text-sm font-medium text-green-700"
                >
                  <Check aria-hidden="true" className="size-4" />
                  Correct
                </span>
              ) : item.correct === 0 ? (
                <span
                  data-testid="quiz-review-mark"
                  data-correct="false"
                  className="flex items-center gap-1 text-sm font-medium text-red-700"
                >
                  <X aria-hidden="true" className="size-4" />
                  Incorrect
                </span>
              ) : null}
            </div>
            <Markdown>{item.exercise.prompt}</Markdown>
            <p className={item.correct === 0 ? 'text-red-700' : undefined}>
              <span className="font-medium">Your answer: </span>
              <Markdown inline>{item.yourAnswer}</Markdown>
            </p>
            {item.correct != null && item.correct >= 1 ? null : (
              <p>
                <span className="font-medium">Correct answer: </span>
                <Markdown inline>{item.correctAnswer}</Markdown>
              </p>
            )}
            <div>
              <p className="font-medium">Working</p>
              <Markdown>{item.solution}</Markdown>
            </div>
          </article>
        ))}
      </CardContent>
    </Card>
  );
}
