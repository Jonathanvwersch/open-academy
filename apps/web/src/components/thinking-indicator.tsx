import { TortoiseMark } from './tortoise-mark.js';

export function ThinkingIndicator() {
  return (
    <div
      role="status"
      aria-label="Thinking"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <span className="inline-flex motion-safe:animate-[pulse_3s_ease-in-out_infinite]">
        <TortoiseMark className="size-6" />
      </span>
      <span>Thinking…</span>
    </div>
  );
}
