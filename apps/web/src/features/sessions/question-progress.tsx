import { cn } from '../../lib/utils.js';

export type QuestionState = 'correct' | 'incorrect' | 'done' | 'current' | 'upcoming';

const stateClasses: Record<QuestionState, string> = {
  correct: 'bg-green-500',
  incorrect: 'bg-amber-500',
  done: 'bg-foreground/40',
  current: 'border-2 border-primary bg-transparent',
  upcoming: 'bg-muted-foreground/20',
};

const stateLabels: Record<QuestionState, string> = {
  correct: 'correct',
  incorrect: 'incorrect',
  done: 'completed',
  current: 'current',
  upcoming: 'upcoming',
};

export function QuestionProgress({ states }: { states: QuestionState[] }) {
  if (states.length <= 1) return null;

  const currentIndex = states.indexOf('current');
  const questionIndex =
    currentIndex >= 0
      ? currentIndex
      : states.reduce(
          (lastIndex, state, index) =>
            state === 'correct' || state === 'incorrect' || state === 'done' ? index : lastIndex,
          -1,
        );
  const stateCounts: Record<QuestionState, number> = {
    correct: 0,
    incorrect: 0,
    done: 0,
    current: 0,
    upcoming: 0,
  };

  return (
    <div
      data-testid="question-progress"
      className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2"
    >
      <p className="text-sm text-muted-foreground">
        Question {Math.max(0, questionIndex) + 1} of {states.length}
      </p>
      <ol aria-label="Questions" className="flex min-w-0 max-w-full flex-wrap gap-2">
        {states.map((state, index) => {
          const key = `${state}-${stateCounts[state]}`;
          stateCounts[state] += 1;
          return (
            <li
              key={key}
              data-state={state}
              className={cn('size-2.5 shrink-0 rounded-full', stateClasses[state])}
            >
              <span className="sr-only">
                Question {index + 1}, {stateLabels[state]}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
