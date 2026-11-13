import type { LessonRunPayload } from '@academy/contracts/lessons';
import { Badge } from '../../components/ui/badge.js';
export function LessonSteps({
  state,
  viewingPastStep,
  viewingPointId,
  currentPointId,
  viewStep,
  returnToCurrentStep,
}: {
  state: NonNullable<LessonRunPayload['run']>;
  viewingPastStep: boolean;
  viewingPointId: string | null;
  currentPointId: string | undefined;
  viewStep: (id: string) => void;
  returnToCurrentStep: () => void;
}) {
  return (
    <ol
      aria-label="Lesson steps"
      className="flex flex-wrap gap-2 [&_[data-slot=badge]]:h-9 [&_[data-slot=badge]]:min-w-16 [&_[data-slot=badge]]:justify-center [&_[data-slot=badge]]:rounded-lg [&_[data-slot=badge]]:px-3 [&_[data-slot=badge]]:text-xs"
    >
      {state.points.map((item, index) => (
        <li key={item.id}>
          {item.status === 'passed' ||
          item.id === state.currentPointId ||
          state.status === 'quiz' ||
          state.status === 'completed' ? (
            <Badge
              asChild
              variant="outline"
              className={`${
                item.status === 'passed'
                  ? 'border-green-300 bg-green-50 text-green-900'
                  : item.id === state.currentPointId
                    ? 'border-primary bg-muted text-foreground'
                    : 'border-border text-muted-foreground'
              } cursor-pointer hover:brightness-95 ${
                viewingPastStep && item.id === viewingPointId ? 'ring-1 ring-primary' : ''
              }`}
            >
              <button
                type="button"
                aria-label={`Step ${index + 1} of ${state.points.length}, ${
                  item.status === 'passed'
                    ? 'passed'
                    : item.id === state.currentPointId
                      ? 'current'
                      : 'locked'
                }`}
                aria-current={
                  (viewingPastStep && item.id === viewingPointId) ||
                  (!viewingPastStep &&
                    state.status === 'in_progress' &&
                    item.id === (currentPointId ?? state.currentPointId))
                    ? 'step'
                    : undefined
                }
                onClick={() => viewStep(item.id)}
              >
                {item.status === 'passed' ? '✓ ' : ''}
                Step {index + 1}
              </button>
            </Badge>
          ) : (
            <Badge variant="outline" className="border-border text-muted-foreground">
              Step {index + 1}
            </Badge>
          )}
        </li>
      ))}
      <li>
        {state.status === 'completed' || state.quiz.bestPassed ? (
          <Badge
            variant="outline"
            data-testid="lesson-quiz-chip"
            aria-label="Lesson quiz, passed"
            className="border-green-300 bg-green-50 text-green-900"
          >
            ✓ Quiz
          </Badge>
        ) : state.status === 'quiz' ? (
          viewingPastStep ? (
            <Badge
              asChild
              variant="outline"
              data-testid="lesson-quiz-chip"
              aria-label="Lesson quiz, current"
              className="cursor-pointer border-primary bg-muted text-foreground hover:brightness-95"
            >
              <button type="button" onClick={returnToCurrentStep}>
                Quiz
              </button>
            </Badge>
          ) : (
            <Badge
              variant="outline"
              data-testid="lesson-quiz-chip"
              aria-label="Lesson quiz, current"
              className="border-primary bg-muted text-foreground"
            >
              Quiz
            </Badge>
          )
        ) : (
          <Badge
            variant="outline"
            data-testid="lesson-quiz-chip"
            aria-label="Lesson quiz, upcoming"
            className="border-border text-muted-foreground"
          >
            Quiz
          </Badge>
        )}
      </li>
    </ol>
  );
}
