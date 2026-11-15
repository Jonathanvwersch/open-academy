import { Pause, Play, RotateCcw } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../../../components/ui/button.js';
import { coordinateLabel, eigenInputs, eigenTransform, type Point } from './eigen-transform.js';

const DURATION = 6000;
const origin: Point = [136, 245];
const scale = 50;
const reduceQuery = '(prefers-reduced-motion: reduce)';
const motionPreference = {
  subscribe: (onChange: () => void) => {
    const query = window.matchMedia(reduceQuery);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  },
  getSnapshot: () => window.matchMedia(reduceQuery).matches,
  getServerSnapshot: () => true,
};

function screen([x, y]: Point): Point {
  return [origin[0] + scale * x, origin[1] - scale * y];
}
function segment(start: Point, end: Point) {
  return `M ${screen(start).join(' ')} L ${screen(end).join(' ')}`;
}

export function EigenDirections({ fallback }: { fallback: ReactNode }) {
  const reducedMotion = useSyncExternalStore(
    motionPreference.subscribe,
    motionPreference.getSnapshot,
    motionPreference.getServerSnapshot,
  );
  const id = useId().replaceAll(':', '');
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const progressRef = useRef(progress);
  const [selection, setSelection] = useState(0);
  const input = eigenInputs[selection] ?? eigenInputs[0];
  const output = eigenTransform(input.point, progress);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);
  useEffect(() => {
    if (!playing || reducedMotion) return;
    let frame = 0;
    let previous: number | undefined;
    const tick = (now: number) => {
      if (previous !== undefined) {
        const delta = Math.min(now - previous, 100) / DURATION;
        const value = Math.min(1, progressRef.current + delta);
        progressRef.current = value;
        setProgress(value);
        if (value >= 1) {
          setPlaying(false);
          return;
        }
      }
      previous = now;
      frame = window.requestAnimationFrame(tick);
    };
    const pauseWhenHidden = () => {
      if (document.hidden) setPlaying(false);
    };
    frame = window.requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', pauseWhenHidden);
    };
  }, [playing, reducedMotion]);
  useEffect(() => {
    if (reducedMotion) setPlaying(false);
  }, [reducedMotion]);

  if (reducedMotion) return <div data-testid="eigen-motion-static">{fallback}</div>;

  const [endX, endY] = screen(output);
  return (
    <figure
      data-testid="eigen-motion"
      className="my-6 overflow-hidden rounded-xl border border-border bg-card"
    >
      <figcaption className="space-y-1 px-4 pt-4 sm:px-5">
        <p className="text-base font-medium">Watch a matrix move an arrow</p>
        <p className="text-sm text-muted-foreground">
          Playback moves once from the input to A's result. Grey marks the input; blue grid lines
          follow the originally evenly spaced points. Watch whether the blue arrow leaves its dashed
          line.
        </p>
      </figcaption>
      <fieldset aria-label="Input vector" className="mt-4 grid grid-cols-3 gap-2 px-4 sm:px-5">
        {eigenInputs.map((vector, index) => (
          <Button
            key={vector.label}
            type="button"
            variant={selection === index ? 'secondary' : 'outline'}
            aria-pressed={selection === index}
            onClick={() => setSelection(index)}
            className="min-w-0 px-2"
          >
            {vector.label}
          </Button>
        ))}
      </fieldset>
      <svg
        viewBox="0 0 480 350"
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
        className="block w-full"
        style={{ fontFamily: 'inherit' }}
      >
        <title id={`${id}-title`}>
          The matrix with rows (2, 1) and (1, 2) moves a grid and an arrow.
        </title>
        <desc id={`${id}-description`}>
          The selected input is {input.label}. Its final output is {coordinateLabel(input.output)}.{' '}
          {input.result} Use the progress slider to follow the transformation.
        </desc>
        <defs>
          <clipPath id={`${id}-clip`}>
            <rect x="16" y="16" width="448" height="318" rx="8" />
          </clipPath>
          <marker
            id={`${id}-blue`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 Z" fill="#3b82f6" />
          </marker>
          <marker
            id={`${id}-grey`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 Z" fill="#737373" />
          </marker>
        </defs>
        <g clipPath={`url(#${id}-clip)`}>
          {Array.from({ length: 17 }, (_, index) => index - 8).flatMap((k) => [
            <path
              key={`horizontal-${k}`}
              d={segment(eigenTransform([-8, k], progress), eigenTransform([8, k], progress))}
              stroke="#3b82f6"
              strokeOpacity={k === 0 ? 0.35 : 0.13}
              fill="none"
            />,
            <path
              key={`vertical-${k}`}
              d={segment(eigenTransform([k, -8], progress), eigenTransform([k, 8], progress))}
              stroke="#3b82f6"
              strokeOpacity={k === 0 ? 0.35 : 0.13}
              fill="none"
            />,
          ])}
          <path
            d={segment([-3, 0], [7, 0]) + segment([0, -3], [0, 5])}
            stroke="currentColor"
            opacity="0.3"
          />
          <path
            d={segment(
              [-2 * input.point[0], -2 * input.point[1]],
              [5 * input.point[0], 5 * input.point[1]],
            )}
            stroke="#737373"
            strokeDasharray="5 6"
            strokeWidth="1.5"
          />
          <path
            d={segment([0, 0], input.point)}
            stroke="#737373"
            strokeWidth="2.5"
            strokeOpacity="0.65"
            markerEnd={`url(#${id}-grey)`}
          />
          {eigenInputs.map((vector, index) => (
            <path
              key={vector.label}
              d={segment([0, 0], eigenTransform(vector.point, progress))}
              stroke="#3b82f6"
              strokeWidth={selection === index ? 3.5 : 2}
              strokeOpacity={selection === index ? 1 : 0.18}
              markerEnd={selection === index ? `url(#${id}-blue)` : undefined}
            />
          ))}
          <circle cx={origin[0]} cy={origin[1]} r="3" fill="currentColor" />
        </g>
        <g fill="currentColor" fontSize="18" opacity="0.6">
          <text x="448" y={origin[1] - 8}>
            x
          </text>
          <text x={origin[0] + 9} y="30">
            y
          </text>
          <text x={origin[0] - 15} y={origin[1] + 22}>
            0
          </text>
        </g>
        <text
          x={endX + 12}
          y={endY - 12}
          fill="#3b82f6"
          fontSize="21"
          fontWeight="500"
          stroke="var(--card)"
          strokeWidth="6"
          paintOrder="stroke"
        >
          {coordinateLabel(output)}
        </text>
      </svg>
      <div className="space-y-3 border-t border-border px-4 py-4 sm:px-5">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">At the end: </span>
          {input.result}
        </p>
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (!playing && progress >= 1) setProgress(0);
                setPlaying(!playing);
              }}
            >
              {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
              {playing ? 'Pause' : 'Play'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                progressRef.current = 0;
                setProgress(0);
                setPlaying(true);
              }}
            >
              <RotateCcw aria-hidden="true" />
              Replay
            </Button>
          </div>
          <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">
            {Math.round(progress * 100)}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(progress * 100)}
          aria-label="Transformation progress"
          aria-valuetext={`${Math.round(progress * 100)} percent; output ${coordinateLabel(output)}`}
          onChange={(event) => {
            setPlaying(false);
            setProgress(Number(event.target.value) / 100);
          }}
          className="h-6 w-full cursor-pointer accent-primary"
        />
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>Input</span>
          <span>After A</span>
        </div>
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Show the static diagram</summary>
          {fallback}
        </details>
      </div>
    </figure>
  );
}
