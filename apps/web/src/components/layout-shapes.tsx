export interface Shape {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  kind: 'frame' | 'content' | 'rule';
}

export interface Layout {
  height: number;
  shapes: Shape[];
}

export function isLayout(value: unknown): value is Layout {
  if (!value || typeof value !== 'object') return false;
  const layout = value as { height?: unknown; shapes?: unknown };
  return (
    typeof layout.height === 'number' &&
    Number.isFinite(layout.height) &&
    layout.height >= 0 &&
    Array.isArray(layout.shapes) &&
    layout.shapes.length <= 2000 &&
    layout.shapes.every((shape: unknown) => {
      if (!shape || typeof shape !== 'object') return false;
      const candidate = shape as Record<string, unknown>;
      return (
        (candidate.kind === 'frame' || candidate.kind === 'content' || candidate.kind === 'rule') &&
        [candidate.x, candidate.y, candidate.width, candidate.height, candidate.radius].every(
          (coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
        )
      );
    })
  );
}

export function LayoutShapeLayer({ shapes }: { shapes: Shape[] }) {
  return (
    <div aria-hidden="true" data-layout-shape-layer>
      {shapes.map((shape) => (
        <div
          key={`${shape.kind}-${shape.x}-${shape.y}-${shape.width}-${shape.height}`}
          data-layout-shape={shape.kind}
          className={`absolute ${
            shape.kind === 'frame'
              ? 'bg-card ring-1 ring-foreground/10'
              : shape.kind === 'rule'
                ? 'bg-border'
                : 'animate-pulse bg-muted motion-reduce:animate-none'
          }`}
          style={{
            left: shape.x,
            top: shape.y,
            width: shape.width,
            height: shape.kind === 'rule' ? 1 : shape.height,
            borderRadius: shape.kind === 'rule' ? 0 : shape.radius,
          }}
        />
      ))}
    </div>
  );
}
