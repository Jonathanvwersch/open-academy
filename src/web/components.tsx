import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import * as React from 'react';
import { useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { normalizeDisplayMath } from '../shared/markdown';
import { apiFetch } from './authenticated-fetch.js';
import { cn } from './lib/utils.js';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Checkbox } from './ui/checkbox.js';
import { Input } from './ui/input.js';
import { Label } from './ui/label.js';
import { RadioGroup, RadioGroupItem } from './ui/radio-group.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import { Textarea } from './ui/textarea.js';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

export interface ClientExercise {
  id: string;
  type: string;
  multi?: boolean;
  hintCount?: number;
  prompt: string;
  options?: Array<{ id: string; text: string }>;
  code?: string;
  rubric?: Array<{ id: string; criterion: string; required: boolean }>;
}

export function Markdown({
  children,
  inline = false,
  className,
}: {
  children: string;
  inline?: boolean;
  className?: string;
}) {
  const markdownComponents: Components = {
    code({ className, children: codeChildren, ...props }) {
      if (/\blanguage-svg\b/.test(className ?? '')) {
        const svg = plainText(codeChildren).replace(/\n$/, '');
        const label = svg.match(/\baria-label\s*=\s*["']([^"']+)["']/)?.[1] ?? '';
        return (
          <figure className="my-6 flex max-w-full justify-center">
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
              alt={label}
              className="max-w-full"
              style={{ maxWidth: '70ch' }}
            />
          </figure>
        );
      }
      return (
        <code className={className} {...props}>
          {codeChildren}
        </code>
      );
    },
    pre({ children: preChildren }) {
      const child = React.Children.only(preChildren);
      if (
        React.isValidElement<{ className?: string }>(child) &&
        /language-svg/.test(child.props.className ?? '')
      ) {
        return child;
      }
      return <pre className="overflow-x-auto rounded-lg bg-muted p-4">{preChildren}</pre>;
    },
  };
  const components: Components = inline
    ? {
        ...markdownComponents,
        p({ children: paragraphChildren }) {
          return <span>{paragraphChildren}</span>;
        },
      }
    : markdownComponents;
  const content = (
    <ReactMarkdown
      components={components}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, rehypeHighlight]}
    >
      {normalizeDisplayMath(children)}
    </ReactMarkdown>
  );
  return inline ? (
    <span className={cn('inline', className)}>{content}</span>
  ) : (
    <div className={cn('markdown max-w-[70ch] text-base leading-7 text-foreground', className)}>
      {content}
    </div>
  );
}

function plainText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(plainText).join('');
  if (React.isValidElement<{ children?: ReactNode }>(children)) {
    return plainText(children.props.children);
  }
  return '';
}

export type LessonBlockKind =
  | 'objective'
  | 'fits'
  | 'intuition'
  | 'example'
  | 'math'
  | 'worked'
  | 'check'
  | 'faded'
  | 'summary';

const lessonBlockLabels: Partial<Record<LessonBlockKind, string>> = {
  objective: 'Goal',
  fits: 'Where this fits',
  example: 'Example',
  math: 'Key formula',
  worked: 'Worked example',
  check: 'Check yourself',
  faded: 'Fill in the steps',
  summary: 'Key takeaways',
};

export function LessonBlock({
  kind,
  md,
  children,
}: {
  kind: LessonBlockKind;
  md?: string;
  children?: ReactNode;
}) {
  const content =
    kind === 'objective'
      ? md
          ?.replace(/^\s*\*\*Goal:\*\*\s*/, '')
          .replace(
            /^(\s*)([a-z])/,
            (_, space: string, letter: string) => space + letter.toUpperCase(),
          )
      : md;
  if (kind === 'intuition') {
    return (
      <div className="py-1">
        {content ? <Markdown>{content}</Markdown> : null}
        {children}
      </div>
    );
  }
  return (
    <Card className={kind === 'worked' ? 'gap-2 bg-muted/50' : 'gap-2'}>
      <CardHeader className="gap-0">
        <CardTitle className="text-sm font-medium">{lessonBlockLabels[kind]}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {content ? <Markdown>{content}</Markdown> : null}
        {children}
      </CardContent>
    </Card>
  );
}

export function ModeBadge({ mode }: { mode: 'practice' | 'assessment' | 'review' }) {
  return (
    <Badge variant="outline">
      {mode === 'assessment' ? 'Assessment — no help' : mode === 'review' ? 'Review' : 'Practice'}
    </Badge>
  );
}

export function FeedbackPanel({ result }: { result: Record<string, unknown> }) {
  const title =
    result.status === 'self_check_required'
      ? ''
      : Number(result.correct) >= 1
        ? 'Correct'
        : Number(result.correct) > 0
          ? 'Partly correct'
          : 'Not quite';
  const feedback = typeof result.feedback === 'string' ? result.feedback.trim() : '';
  const repeatsTitle = feedback.replace(/\.$/, '') === title;
  const rubric = Array.isArray(result.rubric)
    ? (result.rubric as Array<{ id?: string; criterion?: string; judgement?: string }>)
    : [];
  const correct = Number(result.correct) >= 1;
  const partial = Number(result.correct) > 0 && !correct;
  const statusClass =
    result.status === 'self_check_required'
      ? 'border-amber-300 bg-amber-50 text-amber-950'
      : correct
        ? 'border-green-300 bg-green-50 text-green-950'
        : partial
          ? 'border-amber-300 bg-amber-50 text-amber-950'
          : 'border-red-300 bg-red-50 text-red-950';
  return (
    <Alert role="status" className={`${statusClass} text-base`}>
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {feedback && !repeatsTitle ? (
        <AlertDescription className="mt-1 text-base text-inherit">
          <Markdown>{feedback}</Markdown>
        </AlertDescription>
      ) : null}
      {rubric.some((item) => item.judgement) ? (
        <ul className="mt-3 space-y-2">
          {rubric.map((item) => {
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
      {typeof result.yourAnswer === 'string' ? (
        <div className="mt-3 space-y-2">
          <div>
            <p className="font-medium">Your answer:</p>
            <Markdown>{result.yourAnswer}</Markdown>
          </div>
          {typeof result.correctAnswer === 'string' ? (
            <div>
              <p className="font-medium">Correct answer:</p>
              <Markdown>{result.correctAnswer}</Markdown>
            </div>
          ) : null}
        </div>
      ) : null}
      {typeof result.exemplar === 'string' ? (
        <div className="mt-3 border-t border-current/15 pt-3">
          <p className="mb-1 font-medium">Model answer</p>
          <Markdown>{result.exemplar}</Markdown>
        </div>
      ) : null}
      {typeof result.exemplar !== 'string' &&
      typeof result.solution === 'string' &&
      result.solution.trim() ? (
        <div className="mt-3 border-t border-current/15 pt-3">
          <p className="mb-1 font-medium">Solution</p>
          <Markdown>{result.solution}</Markdown>
        </div>
      ) : null}
    </Alert>
  );
}

export function ExerciseForm({
  exercise,
  onSubmit,
  disabled = false,
  submitLabel = 'Submit answer',
  explainStep = 'answer',
  readOnlyAnswer,
}: {
  exercise: ClientExercise;
  onSubmit: (answer: unknown) => void;
  disabled?: boolean;
  submitLabel?: string;
  explainStep?: 'answer' | 'self-check';
  readOnlyAnswer?: string;
}) {
  const [value, setValue] = useState('');
  const [line, setLine] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<string[]>([]);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (exercise.type === 'debug') {
      onSubmit({ line: Number(line), fixId: value });
    } else if (exercise.type === 'mc') {
      onSubmit(selected.length === 1 ? selected[0] : selected);
    } else if (exercise.type === 'explain') {
      onSubmit({
        text: explainStep === 'self-check' ? (readOnlyAnswer ?? value) : value,
        ...(explainStep === 'self-check' ? { metCriteria: criteria } : {}),
      });
    } else if (exercise.type === 'numeric') {
      onSubmit(value.trim());
    } else if (exercise.type === 'code_read') {
      onSubmit(
        value.trim() === '' || !Number.isFinite(Number(value)) ? value.trim() : Number(value),
      );
    } else {
      onSubmit(value);
    }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
      return;
    }
    if (exercise.type === 'mc' && /^[1-9]$/.test(event.key)) {
      const option = exercise.options?.[Number(event.key) - 1];
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
    <form onSubmit={submit} onKeyDown={handleKeyDown} className="space-y-4">
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
              {(exercise.options ?? []).map((option) => {
                const optionId = `${exercise.id}-${option.id}`;
                return (
                  <Label
                    key={option.id}
                    htmlFor={optionId}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card p-3"
                  >
                    <Checkbox
                      id={optionId}
                      checked={selected.includes(option.id)}
                      onCheckedChange={(checked) =>
                        setSelected((current) =>
                          checked
                            ? [...current, option.id]
                            : current.filter((id) => id !== option.id),
                        )
                      }
                    />
                    <span className="text-base leading-6 font-normal">
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
              {(exercise.options ?? []).map((option) => {
                const optionId = `${exercise.id}-${option.id}`;
                return (
                  <Label
                    key={option.id}
                    htmlFor={optionId}
                    className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card p-3"
                  >
                    <RadioGroupItem id={optionId} value={option.id} />
                    <span className="text-base leading-6 font-normal">
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
          <div className="space-y-2">
            <Label htmlFor={`${exercise.id}-line`}>Buggy line</Label>
            <Select value={line} onValueChange={setLine}>
              <SelectTrigger id={`${exercise.id}-line`} className="w-full">
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
          </div>
          <div className="space-y-2">
            <Label htmlFor={`${exercise.id}-fix`}>Fix</Label>
            <Select value={value} onValueChange={setValue}>
              <SelectTrigger id={`${exercise.id}-fix`} className="w-full">
                <SelectValue placeholder="Choose a fix" />
              </SelectTrigger>
              <SelectContent>
                {(
                  exercise as ClientExercise & { fix_options?: Array<{ id: string; text: string }> }
                ).fix_options?.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    <Markdown inline>{option.text}</Markdown>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : null}
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
      {exercise.type !== 'mc' &&
      exercise.type !== 'debug' &&
      !(exercise.type === 'explain' && explainStep === 'self-check') ? (
        exercise.type === 'numeric' || exercise.type === 'code_read' || exercise.type === 'text' ? (
          <Input
            className="w-full"
            aria-label="Your answer"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Type your answer"
          />
        ) : (
          <Textarea
            className={`min-h-28 w-full ${exercise.type === 'explain' ? '' : 'font-mono'}`}
            aria-label="Your answer"
            value={value}
            onChange={(event) => setValue(event.target.value)}
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
      <Button type="submit" disabled={disabled}>
        {submitLabel}
      </Button>
    </form>
  );
}

export function HintLadder({
  exerciseId,
  activityId,
  hintCount = 0,
  tutorEnabled = false,
  onHint,
  mode = 'practice',
  buttonRef,
}: {
  exerciseId: string;
  activityId?: string;
  hintCount?: number;
  tutorEnabled?: boolean;
  onHint: (result: {
    level: number;
    text: string;
    revealedSolution: boolean;
    tutorUnavailable?: boolean;
  }) => void;
  mode?: 'practice' | 'review';
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState(0);
  const [solutionShown, setSolutionShown] = useState(false);
  const [hasMore, setHasMore] = useState(tutorEnabled);
  const canRequestHint = level < hintCount || (tutorEnabled && hasMore);
  const showSolution = !canRequestHint;
  const requestHint = async () => {
    setLoading(true);
    const response = await apiFetch('/api/hints', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        exerciseId,
        activityId,
        mode,
        stuck: mode === 'review',
        revealSolution: showSolution,
      }),
    });
    const data = await response.json();
    if (response.ok) {
      if (data.revealedSolution) {
        onHint(data);
        setSolutionShown(true);
      } else if (typeof data.text === 'string' || data.tutorUnavailable) {
        onHint({ ...data, text: data.text ?? '' });
        setLevel(data.level ?? hintCount);
        setHasMore(Boolean(data.hasMore));
      } else {
        setLevel(hintCount);
        setHasMore(false);
      }
    }
    setLoading(false);
  };
  if (solutionShown) return null;
  return (
    <Button
      ref={buttonRef}
      type="button"
      disabled={loading}
      onClick={requestHint}
      variant="outline"
      size="sm"
    >
      {loading
        ? 'Loading…'
        : showSolution
          ? 'Show solution'
          : mode === 'review'
            ? 'Show a hint'
            : 'Hint'}
    </Button>
  );
}
