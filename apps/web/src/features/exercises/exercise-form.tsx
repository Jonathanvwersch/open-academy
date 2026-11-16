import type { AnswerOptions, ClientExercise } from '@academy/contracts/exercises';
import { emptyAnswerMessage } from '@academy/shared/answer-validation';
import { onScreenOptions } from '@academy/shared/shuffle';
import { Check, X } from 'lucide-react';
import type { FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { RadioGroup, RadioGroupItem } from '../../components/ui/radio-group.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { prefillExerciseAnswer } from './submitted-answer.js';

const EXERCISE_CONTAINER_SELECTOR = '[data-exercise-container]';
const isTextEntryField = (element: Element | null) =>
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement &&
    ![
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ].includes(element.type)) ||
  (element instanceof HTMLElement && element.isContentEditable);

export function ExerciseForm({
  exercise,
  onSubmit,
  timerResetKey,
  restartTimerOnInteraction = false,
  disabled = false,
  loading = false,
  submitLabel = 'Submit answer',
  explainStep = 'answer',
  readOnlyAnswer,
  submittedAnswer,
  answerOptions,
  locked = false,
  inputAreaMinHeight,
  primaryAction,
  actions,
  compactActions = false,
  autoFocus = true,
}: {
  exercise: ClientExercise;
  onSubmit: (answer: unknown, durationMs: number) => void;
  timerResetKey?: number | string;
  restartTimerOnInteraction?: boolean;
  disabled?: boolean;
  loading?: boolean;
  submitLabel?: string;
  explainStep?: 'answer' | 'self-check';
  readOnlyAnswer?: string;
  submittedAnswer?: unknown;
  answerOptions?: AnswerOptions;
  locked?: boolean;
  inputAreaMinHeight?: number;
  primaryAction?: {
    label: string;
    onClick: () => void;
    loading?: boolean;
    disabled?: boolean;
  };
  actions?: ReactNode;
  compactActions?: boolean;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState('');
  const [line, setLine] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<string[]>([]);
  const [answerError, setAnswerError] = useState('');
  const answerInputRef = useRef<HTMLInputElement>(null);
  const answerTextareaRef = useRef<HTMLTextAreaElement>(null);
  const answerStartedAt = useRef(performance.now());
  const restartTimerAfterFeedback = useRef(false);
  const currentTimerResetKey = useRef(timerResetKey);
  const options = exercise.options;
  const orderedOptions = useMemo(
    () => onScreenOptions(options ?? [], exercise.id),
    [exercise.id, options],
  );
  const fixOptions = (
    exercise as ClientExercise & { fix_options?: Array<{ id: string; text: string }> }
  ).fix_options;
  const orderedFixOptions = useMemo(
    () => onScreenOptions(fixOptions ?? [], exercise.id),
    [exercise.id, fixOptions],
  );
  const inputsLocked = locked || disabled || loading;
  useEffect(() => {
    if (currentTimerResetKey.current !== timerResetKey) {
      answerStartedAt.current = performance.now();
      currentTimerResetKey.current = timerResetKey;
    }
    restartTimerAfterFeedback.current = restartTimerOnInteraction;
  }, [restartTimerOnInteraction, timerResetKey]);
  const startTimerAfterFeedback = () => {
    if (!restartTimerAfterFeedback.current) return;
    answerStartedAt.current = performance.now();
    restartTimerAfterFeedback.current = false;
  };
  useEffect(() => {
    const answerInput = answerInputRef.current ?? answerTextareaRef.current;
    if (!autoFocus || inputsLocked || !answerInput) return;

    const activeElement = document.activeElement;
    if (
      isTextEntryField(activeElement) &&
      activeElement !== answerInput &&
      !answerInput.closest(EXERCISE_CONTAINER_SELECTOR)?.contains(activeElement)
    ) {
      return;
    }

    answerInput.focus({ preventScroll: true });
  }, [autoFocus, inputsLocked]);
  useEffect(() => {
    if (!primaryAction) return;
    const handleGlobalKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const targetElement = target instanceof Element ? target : null;
      const lockedAnswerField =
        (targetElement instanceof HTMLInputElement ||
          targetElement instanceof HTMLTextAreaElement) &&
        (targetElement.readOnly || targetElement.disabled) &&
        Boolean(targetElement.closest(EXERCISE_CONTAINER_SELECTOR));
      if (
        event.key !== 'Enter' ||
        event.isComposing ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        (targetElement instanceof HTMLTextAreaElement && !lockedAnswerField)
      ) {
        return;
      }
      const nonTextInput =
        targetElement instanceof HTMLInputElement &&
        ['checkbox', 'color', 'radio', 'range'].includes(targetElement.type);
      const inExerciseCard = Boolean(targetElement?.closest(EXERCISE_CONTAINER_SELECTOR));
      const isPageTarget = target === document || target === document.body;
      if (!isPageTarget && !inExerciseCard && !nonTextInput) return;
      const interactiveTarget = targetElement?.closest(
        'button, a, area, select, textarea, input, label, summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="slider"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="treeitem"], [role="gridcell"], [tabindex]:not([tabindex="-1"])',
      );
      const isExerciseCard = targetElement?.matches(EXERCISE_CONTAINER_SELECTOR) === true;
      const isRadioGroup = targetElement?.matches('[role="radiogroup"]') === true;
      const disabledRadio = targetElement?.closest(
        '[role="radio"]:disabled, [role="radio"][aria-disabled="true"], input[type="radio"]:disabled',
      );
      if (
        interactiveTarget &&
        !isPageTarget &&
        !(nonTextInput && interactiveTarget === targetElement) &&
        !(isExerciseCard && interactiveTarget === targetElement) &&
        !(isRadioGroup && inExerciseCard && interactiveTarget === targetElement) &&
        !(disabledRadio && inExerciseCard && interactiveTarget === disabledRadio) &&
        !lockedAnswerField
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!primaryAction.loading && !primaryAction.disabled) primaryAction.onClick();
    };
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [primaryAction]);
  useEffect(() => {
    if (answerOptions) {
      if (exercise.type === 'mc') {
        setSelected(answerOptions.selected);
      } else if (exercise.type === 'debug') {
        const selectedLine = answerOptions.selected.find((option) => option.startsWith('line:'));
        const selectedFix = answerOptions.selected.find((option) => option.startsWith('fix:'));
        if (selectedLine) setLine(selectedLine.slice('line:'.length));
        if (selectedFix) setValue(selectedFix.slice('fix:'.length));
      }
    } else if (submittedAnswer !== undefined) {
      const prefilled = prefillExerciseAnswer(exercise.type, submittedAnswer);
      if (prefilled.selected) setSelected(prefilled.selected);
      if (prefilled.line !== undefined) setLine(prefilled.line);
      if (prefilled.value !== undefined) setValue(prefilled.value);
    }
  }, [answerOptions, exercise.type, submittedAnswer]);
  const optionState = (id: string, isSelected: boolean) => {
    if (!answerOptions) return undefined;
    if (answerOptions.correct?.includes(id)) return 'correct' as const;
    if (answerOptions.selected.includes(id) && isSelected) return 'incorrect' as const;
    if (!locked && isSelected) return undefined;
    return 'muted' as const;
  };
  const optionClassName = (
    state: 'correct' | 'incorrect' | 'muted' | undefined,
    isSelected = false,
  ) =>
    state === 'correct'
      ? 'border-green-500 bg-green-50 text-green-950 dark:bg-green-950/30 dark:text-green-100'
      : state === 'incorrect'
        ? 'border-red-500 bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100'
        : state === 'muted'
          ? 'border-border bg-muted/50 text-muted-foreground'
          : isSelected
            ? 'border-foreground/35 bg-muted/70 ring-1 ring-foreground/10'
            : 'border-border bg-card hover:bg-muted/40';
  const optionControlClassName = (state: 'correct' | 'incorrect' | 'muted' | undefined) =>
    state === 'correct'
      ? 'border-green-600 bg-green-600 text-white data-checked:bg-green-600'
      : state === 'incorrect'
        ? 'border-red-600 bg-red-600 text-white data-checked:bg-red-600'
        : state === 'muted'
          ? 'opacity-60'
          : undefined;
  const optionIcon = (state: 'correct' | 'incorrect' | 'muted' | undefined) =>
    state === 'correct' ? (
      <Check aria-hidden="true" className="size-3" />
    ) : state === 'incorrect' ? (
      <X aria-hidden="true" className="size-3" />
    ) : undefined;
  const lineOptionState = (id: string) =>
    optionState(id, id === `line:${line}` && answerOptions?.selected.includes(id) === true);
  const fixOptionState = (id: string) =>
    optionState(id, id === `fix:${value}` && answerOptions?.selected.includes(id) === true);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (inputsLocked) return;
    let answer: unknown;
    if (exercise.type === 'debug') {
      answer = { line: Number(line), fixId: value };
    } else if (exercise.type === 'mc') {
      answer = selected.length === 1 ? selected[0] : selected;
    } else if (exercise.type === 'explain') {
      answer = {
        text: explainStep === 'self-check' ? (readOnlyAnswer ?? value) : value,
        ...(explainStep === 'self-check' ? { metCriteria: criteria } : {}),
      };
    } else if (exercise.type === 'numeric') {
      answer = value.trim();
    } else if (exercise.type === 'code_read') {
      answer =
        value.trim() === '' || !Number.isFinite(Number(value)) ? value.trim() : Number(value);
    } else {
      answer = value;
    }
    const emptyMessage = emptyAnswerMessage(exercise.type, answer);
    if (emptyMessage) {
      setAnswerError(emptyMessage);
      return;
    }
    setAnswerError('');
    startTimerAfterFeedback();
    onSubmit(answer, Math.max(0, Math.round(performance.now() - answerStartedAt.current)));
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    ) {
      if (primaryAction) return;
      event.preventDefault();
      if (inputsLocked) {
        return;
      } else {
        event.currentTarget.requestSubmit();
      }
      return;
    }
    if (exercise.type === 'mc' && !inputsLocked && /^[1-9]$/.test(event.key)) {
      const option = orderedOptions[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        if (exercise.multi) {
          setSelected((current) =>
            current.includes(option.id)
              ? current.filter((id) => id !== option.id)
              : [...current, option.id],
          );
        } else {
          setSelected([option.id]);
        }
      }
    }
  };
  return (
    <form
      onSubmit={submit}
      onKeyDown={handleKeyDown}
      onKeyDownCapture={startTimerAfterFeedback}
      onFocusCapture={startTimerAfterFeedback}
      onPointerDownCapture={startTimerAfterFeedback}
      onChangeCapture={startTimerAfterFeedback}
      className="space-y-4"
    >
      {answerError ? (
        <p role="alert" className="text-sm text-destructive">
          {answerError}
        </p>
      ) : null}
      <div
        data-testid="exercise-inputs"
        style={{ minHeight: inputAreaMinHeight }}
        className="space-y-4"
      >
        {exercise.code ? (
          <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-4 text-sm text-neutral-100">
            <code>{exercise.code}</code>
          </pre>
        ) : null}
        {exercise.type === 'mc' ? (
          <fieldset className="space-y-2">
            <legend className="sr-only">Choose an answer</legend>
            {exercise.multi ? (
              <div className="space-y-2">
                {orderedOptions.map((option, index) => {
                  const optionId = `${exercise.id}-${option.id}`;
                  const state = optionState(option.id, selected.includes(option.id));
                  return (
                    <Label
                      key={option.id}
                      htmlFor={optionId}
                      data-option-state={state}
                      className={`flex min-h-12 items-start gap-3 rounded-lg border px-4 py-3 transition-colors focus-within:border-foreground/40 ${
                        inputsLocked ? 'cursor-default' : 'cursor-pointer'
                      } ${optionClassName(state, selected.includes(option.id))}`}
                    >
                      <Checkbox
                        id={optionId}
                        checked={selected.includes(option.id)}
                        disabled={inputsLocked}
                        indicator={optionIcon(state)}
                        className={`mt-1 ${optionControlClassName(state) ?? ''}`}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked
                              ? [...current, option.id]
                              : current.filter((id) => id !== option.id),
                          )
                        }
                      />
                      <span className="mt-0.5 w-5 shrink-0 text-sm font-medium text-muted-foreground">
                        {String.fromCharCode(65 + index)}.
                      </span>
                      <span className="min-w-0 flex-1 text-base leading-6 font-normal">
                        <Markdown inline>{option.text}</Markdown>
                      </span>
                    </Label>
                  );
                })}
              </div>
            ) : (
              <RadioGroup
                aria-label="Choose an answer"
                value={selected[0] ?? ''}
                onValueChange={(next) => setSelected([next])}
              >
                {orderedOptions.map((option, index) => {
                  const optionId = `${exercise.id}-${option.id}`;
                  const state = optionState(option.id, selected.includes(option.id));
                  return (
                    <Label
                      key={option.id}
                      htmlFor={optionId}
                      data-option-state={state}
                      className={`flex min-h-12 items-start gap-3 rounded-lg border px-4 py-3 transition-colors focus-within:border-foreground/40 ${
                        inputsLocked ? 'cursor-default' : 'cursor-pointer'
                      } ${optionClassName(state, selected.includes(option.id))}`}
                    >
                      <RadioGroupItem
                        id={optionId}
                        value={option.id}
                        disabled={inputsLocked}
                        indicator={optionIcon(state)}
                        className={`mt-1 ${optionControlClassName(state) ?? ''}`}
                      />
                      <span className="mt-0.5 w-5 shrink-0 text-sm font-medium text-muted-foreground">
                        {String.fromCharCode(65 + index)}.
                      </span>
                      <span className="min-w-0 flex-1 text-base leading-6 font-normal">
                        <Markdown inline>{option.text}</Markdown>
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
            )}
          </fieldset>
        ) : null}
        {exercise.type === 'debug' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2.5">
              <Label htmlFor={`${exercise.id}-line`}>Buggy line</Label>
              <div className="relative">
                <Select value={line} onValueChange={setLine} disabled={inputsLocked}>
                  <SelectTrigger
                    id={`${exercise.id}-line`}
                    className={`w-full pr-10 ${optionClassName(lineOptionState(`line:${line}`))}`}
                    data-option-state={lineOptionState(`line:${line}`)}
                  >
                    <SelectValue placeholder="Choose a line" />
                  </SelectTrigger>
                  <SelectContent>
                    {(exercise.code?.split(/\\n|\n/) ?? []).map((_, index) => {
                      const lineNumber = index + 1;
                      return (
                        <SelectItem key={lineNumber} value={String(lineNumber)}>
                          Line {lineNumber}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
                {optionIcon(lineOptionState(`line:${line}`)) ? (
                  <span className="pointer-events-none absolute top-1/2 right-8 -translate-y-1/2">
                    {optionIcon(lineOptionState(`line:${line}`))}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="grid gap-2.5">
              <Label htmlFor={`${exercise.id}-fix`}>Fix</Label>
              <div className="relative">
                <Select value={value} onValueChange={setValue} disabled={inputsLocked}>
                  <SelectTrigger
                    id={`${exercise.id}-fix`}
                    className={`w-full pr-10 ${optionClassName(fixOptionState(`fix:${value}`))}`}
                    data-option-state={fixOptionState(`fix:${value}`)}
                  >
                    <SelectValue placeholder="Choose a fix" />
                  </SelectTrigger>
                  <SelectContent>
                    {orderedFixOptions.map((option, index) => (
                      <SelectItem key={option.id} value={option.id}>
                        {String.fromCharCode(65 + index)}. <Markdown inline>{option.text}</Markdown>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {optionIcon(fixOptionState(`fix:${value}`)) ? (
                  <span className="pointer-events-none absolute top-1/2 right-8 -translate-y-1/2">
                    {optionIcon(fixOptionState(`fix:${value}`))}
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {exercise.type === 'explain' && explainStep === 'self-check' ? (
          <Textarea
            className="min-h-28 w-full"
            aria-label="Your answer"
            value={readOnlyAnswer ?? value}
            readOnly
          />
        ) : exercise.type !== 'mc' && exercise.type !== 'debug' ? (
          exercise.type === 'numeric' ||
          exercise.type === 'code_read' ||
          exercise.type === 'text' ? (
            <Input
              ref={answerInputRef}
              className="h-10 w-full"
              aria-label="Your answer"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              readOnly={inputsLocked}
              placeholder="Type your answer"
            />
          ) : (
            <Textarea
              ref={answerTextareaRef}
              className={`min-h-28 w-full ${exercise.type === 'explain' ? '' : 'font-mono'}`}
              aria-label="Your answer"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              readOnly={inputsLocked}
              placeholder={
                exercise.type === 'explain'
                  ? 'Write your explanation'
                  : exercise.type === 'code_complete'
                    ? 'Enter code for the blank'
                    : 'Type your answer'
              }
            />
          )
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type={primaryAction ? 'button' : 'submit'}
          onClick={primaryAction?.onClick}
          disabled={primaryAction?.disabled ?? disabled}
          loading={primaryAction?.loading ?? loading}
          className={`${compactActions ? 'px-3' : 'min-w-48 px-4'} ${primaryAction ? 'max-w-full h-auto min-h-10 whitespace-normal' : 'h-10'}`}
        >
          {primaryAction?.label ?? submitLabel}
        </Button>
        {actions}
      </div>
      {exercise.type === 'explain' && explainStep === 'self-check' ? (
        <fieldset className="space-y-2">
          <legend className="text-base font-medium">Which of these did your answer include?</legend>
          {(exercise.rubric ?? []).map((item) => {
            const itemId = `${exercise.id}-${item.id}`;
            return (
              <div key={item.id} className="flex items-center gap-2">
                <Checkbox
                  id={itemId}
                  checked={criteria.includes(item.id)}
                  disabled={inputsLocked}
                  onCheckedChange={(checked) =>
                    setCriteria((current) =>
                      checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                    )
                  }
                />
                <Label htmlFor={itemId} className="flex items-center gap-2 text-base">
                  <Markdown inline>{item.criterion}</Markdown>
                  {item.required ? (
                    <Badge
                      variant="outline"
                      className="shrink-0 whitespace-nowrap border-amber-300 bg-amber-50 text-amber-950"
                    >
                      key point
                    </Badge>
                  ) : null}
                </Label>
              </div>
            );
          })}
        </fieldset>
      ) : null}
    </form>
  );
}
