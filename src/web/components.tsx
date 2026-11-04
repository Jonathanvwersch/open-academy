import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { normalizeDisplayMath } from '../shared/markdown';
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

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown max-w-[70ch] leading-7 text-neutral-800">
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex, rehypeHighlight]}>
        {normalizeDisplayMath(children)}
      </ReactMarkdown>
    </div>
  );
}

export type LessonBlockKind =
  | 'objective'
  | 'intuition'
  | 'example'
  | 'math'
  | 'worked'
  | 'check'
  | 'faded'
  | 'summary';

const lessonBlockLabels: Partial<Record<LessonBlockKind, string>> = {
  objective: 'Goal',
  example: 'Example',
  math: 'Key formula',
  worked: 'Worked example',
  check: 'Check yourself',
  faded: 'Fill in the steps',
  summary: 'Key takeaways',
};

const lessonBlockStyles: Partial<Record<LessonBlockKind, string>> = {
  objective: 'border-blue-200 border-l-4 border-l-blue-700 bg-blue-50/50',
  example: 'border-neutral-200 bg-amber-50/60',
  math: 'border-neutral-200 bg-slate-50',
  worked: 'border-neutral-200 bg-white',
  check: 'border-blue-200 bg-blue-50/40',
  faded: 'border-blue-200 bg-blue-50/40',
  summary: 'border-neutral-200 bg-neutral-50',
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
    <section
      className={`space-y-3 rounded-lg border p-4 ${lessonBlockStyles[kind] ?? 'border-neutral-200 bg-white'}`}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
        {lessonBlockLabels[kind]}
      </p>
      {content ? <Markdown>{content}</Markdown> : null}
      {children}
    </section>
  );
}

export function ModeBadge({ mode }: { mode: 'practice' | 'assessment' | 'review' }) {
  return (
    <span className="rounded-full border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700">
      {mode === 'review' ? 'Review' : mode === 'practice' ? 'Practice' : 'Assessment — no help'}
    </span>
  );
}

export function FeedbackPanel({ result }: { result: Record<string, unknown> }) {
  const title =
    Number(result.correct) >= 1
      ? 'Correct'
      : Number(result.correct) > 0
        ? 'Partly correct'
        : 'Not quite';
  const feedback = typeof result.feedback === 'string' ? result.feedback.trim() : '';
  const repeatsTitle = feedback.replace(/\.$/, '') === title;
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4" role="status">
      <p className="font-medium">{title}</p>
      {feedback && !repeatsTitle ? (
        <div className="mt-1 text-sm text-neutral-600">
          <Markdown>{feedback}</Markdown>
        </div>
      ) : null}
      {typeof result.solution === 'string' ? (
        <div className="mt-3 border-t border-neutral-200 pt-3 text-sm">
          <Markdown>{result.solution}</Markdown>
        </div>
      ) : null}
    </div>
  );
}

export function ExerciseForm({
  exercise,
  onSubmit,
}: {
  exercise: ClientExercise;
  onSubmit: (answer: unknown) => void;
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
      onSubmit({ text: value, metCriteria: criteria });
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
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
      return;
    }
    if (exercise.type === 'mc' && /^[1-9]$/.test(event.key)) {
      const option = exercise.options?.[Number(event.key) - 1];
      if (option) {
        event.preventDefault();
        setSelected((current) =>
          current.includes(option.id)
            ? current.filter((id) => id !== option.id)
            : [...current, option.id],
        );
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
          {(exercise.options ?? []).map((option) => (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-neutral-200 bg-white p-3"
            >
              <input
                type={exercise.multi ? 'checkbox' : 'radio'}
                name={`answer-${exercise.id}`}
                checked={selected.includes(option.id)}
                onChange={(event) => {
                  if (!exercise.multi) {
                    setSelected(event.target.checked ? [option.id] : []);
                    return;
                  }
                  setSelected((current) =>
                    event.target.checked
                      ? [...current, option.id]
                      : current.filter((id) => id !== option.id),
                  );
                }}
              />
              <Markdown>{option.text}</Markdown>
            </label>
          ))}
        </fieldset>
      ) : null}
      {exercise.type === 'debug' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Buggy line
            <select
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white p-2"
              value={line}
              onChange={(event) => setLine(event.target.value)}
            >
              <option value="">Choose a line</option>
              {(exercise.code?.split(/\\n|\n/) ?? []).map((_, index) => {
                const lineNumber = index + 1;
                return (
                  <option key={`line-${lineNumber}`} value={lineNumber}>
                    Line {lineNumber}
                  </option>
                );
              })}
            </select>
          </label>
          <label className="text-sm">
            Fix
            <select
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white p-2"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            >
              <option value="">Choose a fix</option>
              {(
                exercise as ClientExercise & { fix_options?: Array<{ id: string; text: string }> }
              ).fix_options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.text}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {exercise.type === 'explain' ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            Self-check: which criteria does your answer meet?
          </legend>
          {(exercise.rubric ?? []).map((item) => (
            <label key={item.id} className="flex gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                checked={criteria.includes(item.id)}
                onChange={(event) =>
                  setCriteria((current) =>
                    event.target.checked
                      ? [...current, item.id]
                      : current.filter((id) => id !== item.id),
                  )
                }
              />
              {item.criterion}
              {item.required ? ' (required)' : ''}
            </label>
          ))}
        </fieldset>
      ) : null}
      {exercise.type !== 'mc' && exercise.type !== 'debug' ? (
        exercise.type === 'numeric' || exercise.type === 'code_read' || exercise.type === 'text' ? (
          <input
            className="w-full rounded-md border border-neutral-300 bg-white p-3 text-sm"
            aria-label="Your answer"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Type your answer"
          />
        ) : (
          <textarea
            className="min-h-28 w-full rounded-md border border-neutral-300 bg-white p-3 font-mono text-sm"
            aria-label="Your answer"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={
              exercise.type === 'code_complete' ? 'Enter code for the blank' : 'Type your answer'
            }
          />
        )
      ) : null}
      <button
        type="submit"
        className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800"
      >
        Submit answer
      </button>
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
    const response = await fetch('/api/hints', {
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
    <button
      ref={buttonRef}
      type="button"
      disabled={loading}
      onClick={requestHint}
      className="rounded-md border border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-100"
    >
      {loading
        ? 'Loading…'
        : showSolution
          ? 'Show solution'
          : mode === 'review'
            ? "I'm stuck — show a hint"
            : 'Hint'}
    </button>
  );
}
