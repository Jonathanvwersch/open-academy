import { useRouterState } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface Shape {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  frame: boolean;
}
interface Layout {
  height: number;
  shapes: Shape[];
}
const storageKey = `academy.page-layout.${import.meta.env.PROD ? new URL(import.meta.url).pathname : 'dev-1'}`;
const memory = new Map<string, Layout>();

function layoutKey(path: string, width: number) {
  const breakpoint =
    window.innerWidth < 640 ? 'small' : window.innerWidth < 1024 ? 'medium' : 'large';
  return `${path}:${Math.round(width)}:${breakpoint}`;
}

function compareShapes(left: Shape, right: Shape) {
  return (
    Number(right.frame) - Number(left.frame) ||
    left.y - right.y ||
    left.x - right.x ||
    left.height - right.height ||
    left.width - right.width ||
    left.radius - right.radius
  );
}

export function mergeLineShapes(shapes: Shape[]): Shape[] {
  const content = shapes.filter((shape) => !shape.frame).map((shape) => ({ ...shape }));
  const frames = shapes.filter((shape) => shape.frame);
  content.sort(compareShapes);

  while (true) {
    let merged = false;
    for (let leftIndex = 0; leftIndex < content.length && !merged; leftIndex += 1) {
      const left = content[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < content.length; rightIndex += 1) {
        const right = content[rightIndex];
        if (!right) continue;
        const verticalCenterDifference = Math.abs(
          left.y + left.height / 2 - (right.y + right.height / 2),
        );
        const heightDifference = Math.abs(left.height - right.height);
        const horizontalGap = Math.max(
          0,
          Math.max(left.x, right.x) - Math.min(left.x + left.width, right.x + right.width),
        );
        if (verticalCenterDifference > 2 || heightDifference > 4 || horizontalGap > 8) continue;

        const x = Math.min(left.x, right.x);
        const y = Math.min(left.y, right.y);
        const rightEdge = Math.max(left.x + left.width, right.x + right.width);
        const bottom = Math.max(left.y + left.height, right.y + right.height);
        content.splice(leftIndex, 1, {
          x,
          y,
          width: rightEdge - x,
          height: bottom - y,
          radius: Math.min(left.radius, right.radius),
          frame: false,
        });
        content.splice(rightIndex, 1);
        content.sort(compareShapes);
        merged = true;
        break;
      }
    }
    if (!merged) break;
  }

  return [...content, ...frames].sort(compareShapes);
}

function loadLayout(key: string): Layout | undefined {
  if (memory.has(key)) return memory.get(key);
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? '{}') as Record<string, Layout>;
    const layout = saved[key];
    if (
      layout &&
      Number.isFinite(layout.height) &&
      layout.height >= 0 &&
      Array.isArray(layout.shapes) &&
      layout.shapes.length <= 2000 &&
      layout.shapes.every(
        (shape) =>
          shape &&
          typeof shape.frame === 'boolean' &&
          [shape.x, shape.y, shape.width, shape.height, shape.radius].every(Number.isFinite),
      )
    ) {
      memory.set(key, layout);
      return layout;
    }
  } catch {
    /* Storage is optional; a first visit uses the loading indicator. */
  }
  return undefined;
}

function saveLayout(key: string, layout: Layout) {
  memory.delete(key);
  memory.set(key, layout);
  while (memory.size > 12) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('academy.page-layout.') && key !== storageKey)
        sessionStorage.removeItem(key);
    }
    sessionStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    /* Storage may be unavailable. */
  }
}

const blocks =
  '[data-slot=button], input:not([type=hidden]), textarea, select, [data-slot=badge], [data-slot=progress], [role=radio], [role=checkbox], [role=img], pre, img, canvas, svg, .katex';

function measureLayout(element: HTMLElement): Layout {
  const bounds = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const left = Number.parseFloat(style.paddingLeft) || 0;
  const right = Number.parseFloat(style.paddingRight) || 0;
  const top = Number.parseFloat(style.paddingTop) || 0;
  const bottom = Number.parseFloat(style.paddingBottom) || 0;
  const origin = {
    left: bounds.left + left,
    top: bounds.top + top,
    width: bounds.width - left - right,
    height: bounds.height - top - bottom,
  };
  const shapes: Shape[] = [];
  const clips = new Map<Element, { x: boolean; y: boolean; bounds: DOMRect }>();
  const add = (rect: DOMRect, radius: number, frame = false, clipFrom: Element | null = null) => {
    let left = rect.left;
    let right = rect.right;
    let top = rect.top;
    let bottom = rect.bottom;
    for (let ancestor = clipFrom; ancestor; ancestor = ancestor.parentElement) {
      let clip = clips.get(ancestor);
      if (!clip) {
        const style = getComputedStyle(ancestor);
        clip = {
          x: /auto|scroll|hidden|clip/.test(style.overflowX),
          y: /auto|scroll|hidden|clip/.test(style.overflowY),
          bounds: ancestor.getBoundingClientRect(),
        };
        clips.set(ancestor, clip);
      }
      if (clip.x) {
        left = Math.max(left, clip.bounds.left);
        right = Math.min(right, clip.bounds.right);
      }
      if (clip.y) {
        top = Math.max(top, clip.bounds.top);
        bottom = Math.min(bottom, clip.bounds.bottom);
      }
      if (ancestor === element) break;
    }
    const width = right - left;
    const height = bottom - top;
    if (width < 2 || height < 2) return;
    const x = left - origin.left;
    const y = top - origin.top;
    if (x < -8 || y < -8 || x + width > origin.width + 8) return;
    shapes.push({ x, y, width, height, radius, frame });
  };
  for (const frame of element.querySelectorAll<HTMLElement>(
    '[data-slot=card], [data-slot=alert]',
  )) {
    add(
      frame.getBoundingClientRect(),
      Number.parseFloat(getComputedStyle(frame).borderRadius) || 0,
      true,
      frame.parentElement,
    );
  }
  for (const block of element.querySelectorAll<HTMLElement>(blocks)) {
    const svg = block.tagName.toLowerCase() === 'svg';
    const style = getComputedStyle(block);
    const bounds = block.getBoundingClientRect();
    if (
      block.closest('.sr-only, [data-layout-shape-layer]') ||
      (!svg && (block.parentElement?.closest(blocks) || block.closest('[aria-hidden=true]'))) ||
      (svg &&
        (bounds.width === 0 ||
          bounds.height === 0 ||
          style.visibility === 'hidden' ||
          style.display === 'none'))
    )
      continue;
    add(bounds, Number.parseFloat(style.borderRadius) || 4, false, block.parentElement);
  }
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node && shapes.length < 1500) {
    const parent = node.parentElement;
    if (
      node.textContent?.trim() &&
      parent &&
      !parent.closest(`${blocks}, [aria-hidden=true], .sr-only, svg, script, style`)
    ) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) add(rect, 3, false, parent);
    }
    node = walker.nextNode();
  }
  const unique = new Map(
    mergeLineShapes(shapes).map((shape) => [
      `${shape.frame}-${shape.x}-${shape.y}-${shape.width}-${shape.height}`,
      shape,
    ]),
  );
  return { height: origin.height, shapes: [...unique.values()] };
}

/** Cache geometry only, never text, answers, or HTML. Capture the settled screen, not its fallback. */
export function useCapturePageLayout() {
  const ref = useRef<HTMLDivElement>(null);
  const path = useRouterState({ select: (state) => state.location.href });
  const pending = useRouterState({ select: (state) => state.status === 'pending' });
  useEffect(() => {
    const element = ref.current;
    if (!element || pending) return;
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const capture = () => {
      if (!active) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (
          !active ||
          !element.isConnected ||
          document.fonts.status !== 'loaded' ||
          element.querySelector(
            '[data-testid=route-skeleton], [aria-busy=true], [role=alert], [data-layout-error]',
          )
        )
          return;
        const layout = measureLayout(element);
        if (layout.shapes.length)
          saveLayout(layoutKey(path, element.getBoundingClientRect().width), layout);
      }, 120);
    };
    const resize = new ResizeObserver(capture);
    const mutations = new MutationObserver(capture);
    resize.observe(element);
    mutations.observe(element, { childList: true, subtree: true, characterData: true });
    void document.fonts.ready.then(capture);
    capture();
    return () => {
      active = false;
      clearTimeout(timer);
      resize.disconnect();
      mutations.disconnect();
    };
  }, [path, pending]);
  return ref;
}

export function PageLayoutSkeleton({ fallback }: { fallback?: ReactNode } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const path = useRouterState({ select: (state) => state.location.href });
  const [layout, setLayout] = useState<Layout>();
  useLayoutEffect(() => {
    const frame = ref.current?.closest<HTMLElement>('[data-page-frame]');
    if (!frame) return;
    const update = () =>
      setLayout(loadLayout(layoutKey(path, frame.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [path]);
  return (
    <div
      ref={ref}
      role="status"
      data-testid="route-skeleton"
      className={`relative w-full ${!layout && !fallback ? 'flex flex-1 items-center justify-center' : ''}`}
      aria-busy="true"
      aria-label="Loading page"
      style={layout ? { height: layout.height } : undefined}
    >
      {layout ? (
        <div aria-hidden="true" data-layout-shape-layer>
          {layout.shapes.map((shape) => (
            <div
              key={`${shape.frame}-${shape.x}-${shape.y}-${shape.width}-${shape.height}`}
              data-layout-shape={shape.frame ? 'frame' : 'content'}
              className={
                shape.frame
                  ? 'absolute bg-card ring-1 ring-foreground/10'
                  : 'absolute animate-pulse bg-muted motion-reduce:animate-none'
              }
              style={{
                left: shape.x,
                top: shape.y,
                width: shape.width,
                height: shape.height,
                borderRadius: shape.radius,
              }}
            />
          ))}
        </div>
      ) : fallback ? (
        fallback
      ) : (
        <div className="flex items-center justify-center" data-testid="page-loading-indicator">
          <Loader2
            className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span className="sr-only">Loading</span>
        </div>
      )}
    </div>
  );
}
