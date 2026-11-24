import type { LessonRunPayload } from '@academy/contracts/lessons';
import { Badge } from '../../components/ui/badge.js';
export function LessonSteps({
  state,
  viewingPastStep,
  viewingPointId,
  currentPointId,
  viewStep,
  returnToCurrentStep,
  viewExplain,
  viewQuiz,
  activeStage,
  explain,
  readOnly = false,
}: {
  state: NonNullable<LessonRunPayload['run']>;
  viewingPastStep: boolean;
  viewingPointId: string | null;
  currentPointId: string | undefined;
  viewStep: (id: string) => void;
  returnToCurrentStep: () => void;
  viewExplain: () => void;
  viewQuiz: () => void;
  activeStage?: 'step' | 'explain' | 'quiz';
  explain?: 'upcoming' | 'current' | 'done';
  readOnly?: boolean;
}) {
  const quizPassed = state.status === 'completed' || state.quiz.bestPassed;
  const canReturnToQuiz = activeStage !== 'quiz' && !readOnly && (explain === 'done' || quizPassed);
  return (
    <ol
      aria-label="Lesson steps"
      className="flex flex-wrap gap-2 [&_[data-slot=badge]]:h-9 [&_[data-slot=badge]]:min-w-16 [&_[data-slot=badge]]:justify-center [&_[data-slot=badge]]:rounded-lg [&_[data-slot=badge]]:px-3 [&_[data-slot=badge]]:text-xs"
    >
      {state.points.map((item, index) => {
        const passed = item.status === 'passed';
        const current = item.id === state.currentPointId;
        const available = passed || current;
        const statusClass = passed
          ? 'border-green-300 bg-green-50 text-green-900'
          : current
            ? 'border-primary bg-muted text-foreground'
            : 'border-border text-muted-foreground';
        const ringClass =
          viewingPastStep && item.id === viewingPointId ? 'ring-1 ring-primary' : '';
        const ariaCurrent =
          (viewingPastStep && item.id === viewingPointId) ||
          (!viewingPastStep &&
            state.status === 'in_progress' &&
            item.id === (currentPointId ?? state.currentPointId))
            ? 'step'
            : undefined;
        const label = `${passed ? '✓ ' : ''}Step ${index + 1}`;

        return (
          <li key={item.id} data-testid="lesson-step-chip">
            {readOnly || !available ? (
              <Badge variant="outline" className={`${statusClass} ${ringClass}`}>
                {label}
              </Badge>
            ) : (
              <Badge
                asChild
                variant="outline"
                className={`${statusClass} cursor-pointer hover:brightness-95 ${ringClass}`}
              >
                <button
                  type="button"
                  aria-label={`Step ${index + 1} of ${state.points.length}, ${
                    passed ? 'passed' : current ? 'current' : 'locked'
                  }`}
                  aria-current={ariaCurrent}
                  onClick={() =>
                    item.id === state.currentPointId ? returnToCurrentStep() : viewStep(item.id)
                  }
                >
                  {label}
                </button>
              </Badge>
            )}
          </li>
        );
      })}
      {explain ? (
        <li data-testid="lesson-explain-chip" aria-label={`Explain it, ${explain}`}>
          <Badge
            asChild={explain === 'current' && viewingPastStep && !readOnly}
            variant="outline"
            aria-current={explain === 'current' && !viewingPastStep ? 'step' : undefined}
            className={
              explain === 'done'
                ? 'border-green-300 bg-green-50 text-green-900'
                : explain === 'current'
                  ? 'border-primary bg-muted text-foreground'
                  : 'border-border text-muted-foreground'
            }
          >
            {explain === 'current' && activeStage !== 'explain' && !readOnly ? (
              <button type="button" onClick={viewExplain}>
                Explain it
              </button>
            ) : (
              <>{explain === 'done' ? '✓ ' : ''}Explain it</>
            )}
          </Badge>
        </li>
      ) : null}
      <li>
        {canReturnToQuiz ? (
          <Badge
            asChild
            variant="outline"
            data-testid="lesson-quiz-chip"
            aria-label={`Lesson quiz, ${quizPassed ? 'passed' : 'available'}`}
            className={
              quizPassed
                ? 'cursor-pointer border-green-300 bg-green-50 text-green-900 hover:brightness-95'
                : 'cursor-pointer border-border text-muted-foreground hover:brightness-95'
            }
          >
            <button type="button" onClick={viewQuiz}>
              {quizPassed ? '✓ Quiz' : 'Quiz'}
            </button>
          </Badge>
        ) : explain === 'current' ? (
          <Badge
            variant="outline"
            data-testid="lesson-quiz-chip"
            aria-label="Lesson quiz, upcoming"
            className="border-border text-muted-foreground"
          >
            Quiz
          </Badge>
        ) : state.status === 'quiz' ? (
          <Badge
            variant="outline"
            data-testid="lesson-quiz-chip"
            aria-label={`Lesson quiz, ${activeStage === 'quiz' ? 'current' : 'available'}`}
            aria-current={activeStage === 'quiz' ? 'step' : undefined}
            className="border-primary bg-muted text-foreground"
          >
            Quiz
          </Badge>
        ) : quizPassed ? (
          <Badge
            variant="outline"
            data-testid="lesson-quiz-chip"
            aria-label="Lesson quiz, passed"
            className="border-green-300 bg-green-50 text-green-900"
          >
            ✓ Quiz
          </Badge>
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
