export function ThinkingIndicator() {
  return (
    <div role="status" aria-label="Thinking" className="text-sm text-muted-foreground">
      <span className="animate-pulse motion-reduce:animate-none">Thinking…</span>
    </div>
  );
}
