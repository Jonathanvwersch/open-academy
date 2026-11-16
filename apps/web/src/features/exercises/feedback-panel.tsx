import { Info } from 'lucide-react';
import { Markdown } from '../../components/markdown.js';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert.js';

export function isFinalRetryResult(
  result:
    | { attemptNo?: unknown; retryAllowed?: unknown; correct?: unknown; status?: unknown }
    | null
    | undefined,
) {
  return Boolean(
    result &&
      result.status !== 'invalid' &&
      result.status !== 'self_check_required' &&
      typeof result.correct === 'number' &&
      result.correct !== 1 &&
      Number(result.attemptNo) >= 2 &&
      result.retryAllowed !== true,
  );
}

export function FinalRetryNote() {
  return (
    <p className="text-sm text-muted-foreground">
      That was your last try at this question. Read the model answer, then press Continue.
    </p>
  );
}

export function FeedbackPanel({
  result,
  xp,
  slowTargetSeconds,
  hideAnswerLines = false,
}: {
  result: Record<string, unknown>;
  xp?: number;
  slowTargetSeconds?: number;
  hideAnswerLines?: boolean;
}) {
  const baseTitle =
    result.followUp === true
      ? 'Almost'
      : result.status === 'self_check_required'
        ? ''
        : Number(result.correct) >= 1
          ? 'Correct'
          : Number(result.correct) > 0
            ? 'Partly correct'
            : 'Not quite';
  const title =
    xp !== undefined && Number(result.correct) >= 1 ? `${baseTitle} · +${xp} XP` : baseTitle;
  const rawFeedback = typeof result.feedback === 'string' ? result.feedback.trim() : '';
  const titlePrefix = baseTitle
    ? new RegExp(`^${baseTitle}\\s*(?:[.!,:;–—-]+(?=\\s|$)|$)`, 'i')
    : null;
  const feedbackWithoutTitle = titlePrefix ? rawFeedback.replace(titlePrefix, '') : rawFeedback;
  const feedback =
    feedbackWithoutTitle === rawFeedback
      ? rawFeedback
      : feedbackWithoutTitle
          .trim()
          .replace(/^(\p{Ll})/u, (firstLetter) => firstLetter.toUpperCase());
  const rubric = Array.isArray(result.rubric)
    ? (result.rubric as Array<{
        id?: string;
        criterion?: string;
        judgement?: string;
        required?: boolean;
      }>)
    : [];
  const optionalNotMet = rubric.filter(
    (item) => item.required === false && item.judgement !== 'met',
  );
  const visibleRubric = rubric.filter(
    (item) => item.required !== false || item.judgement === 'met',
  );
  const correct = Number(result.correct) >= 1;
  const partial = Number(result.correct) > 0 && !correct;
  const writtenAnswer = typeof result.exemplar === 'string';
  const showAnswers = typeof result.yourAnswer === 'string' && (writtenAnswer || !correct);
  const solution =
    typeof result.solution === 'string' && result.solution.trim() ? result.solution : '';
  const showFeedback = Boolean(feedback);
  const showSolution =
    result.followUp !== true &&
    !writtenAnswer &&
    Boolean(solution) &&
    !(correct && showFeedback) &&
    !(showAnswers && solution.trim() === String(result.correctAnswer ?? '').trim());
  const solutionHasDivider = showFeedback || showAnswers || rubric.some((item) => item.judgement);
  const statusClass =
    result.status === 'self_check_required'
      ? 'border-amber-300 bg-amber-50 text-amber-950'
      : correct
        ? 'border-green-300 bg-green-50 text-green-950'
        : partial
          ? 'border-amber-300 bg-amber-50 text-amber-950'
          : 'border-red-300 bg-red-50 text-red-950';
  return (
    <Alert role="status" className={`${statusClass} text-base leading-7`}>
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {showFeedback ? (
        <AlertDescription className="mt-1 text-base leading-7 text-inherit">
          <Markdown>{feedback}</Markdown>
        </AlertDescription>
      ) : null}
      {correct && slowTargetSeconds !== undefined ? (
        <p className="mt-2 text-sm leading-5">
          Correct. Try to get this one in under {slowTargetSeconds} seconds next time.
        </p>
      ) : null}
      {rubric.some((item) => item.judgement) ? (
        <ul aria-label="Rubric" className="mt-3 space-y-2">
          {visibleRubric.map((item) => {
            const symbol =
              item.judgement === 'met' ? '✓' : item.judgement === 'partial' ? '½' : '✗';
            return (
              <li key={item.id ?? item.criterion} className="flex gap-2">
                <span aria-hidden="true">{symbol}</span>
                <Markdown inline>{item.criterion ?? ''}</Markdown>
              </li>
            );
          })}
        </ul>
      ) : null}
      {optionalNotMet.length > 0 ? (
        <div className="mt-3">
          <p className="text-sm font-medium text-muted-foreground">Also worth mentioning</p>
          <ul aria-label="Also worth mentioning" className="mt-2 space-y-2">
            {optionalNotMet.map((item) => (
              <li key={item.id ?? item.criterion} className="flex gap-2">
                <span aria-hidden="true" className="text-muted-foreground">
                  •
                </span>
                <Markdown inline>{item.criterion ?? ''}</Markdown>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {showAnswers && !hideAnswerLines ? (
        <div className="mt-3 space-y-2">
          <div>
            <p className="font-medium">Your answer:</p>
            <Markdown>{String(result.yourAnswer)}</Markdown>
          </div>
          {typeof result.correctAnswer === 'string' ? (
            <div>
              <p className="font-medium">Correct answer:</p>
              <Markdown>{result.correctAnswer}</Markdown>
            </div>
          ) : null}
        </div>
      ) : null}
      {result.followUp !== true && typeof result.exemplar === 'string' ? (
        <div className="mt-3 border-t border-current/15 pt-3">
          <p className="mb-1 font-medium">Model answer</p>
          <Markdown>{result.exemplar}</Markdown>
        </div>
      ) : null}
      {showSolution ? (
        solutionHasDivider ? (
          <div className="mt-3 border-t border-current/15 pt-3">
            <p className="mb-1 font-medium">Solution</p>
            <Markdown>{solution}</Markdown>
          </div>
        ) : (
          <AlertDescription className="mt-1 text-base leading-7 text-inherit">
            <Markdown>{solution}</Markdown>
          </AlertDescription>
        )
      ) : null}
      {result.followUp === true ? (
        <div
          data-testid="almost-next-step"
          className="mt-3 flex items-start gap-2 border-t border-current/15 pt-3"
        >
          <Info aria-hidden="true" className="mt-1 size-4 shrink-0" />
          <p>
            {rubric.some(
              (item) =>
                item.required !== false &&
                (item.judgement === 'partial' || item.judgement === 'missing'),
            )
              ? 'Add the points marked ½ or ✗ to your answer above, then press '
              : "Add what's missing to your answer above, then press "}
            <strong>Submit again</strong>. You have one more try before the model answer is shown.
          </p>
        </div>
      ) : null}
    </Alert>
  );
}
