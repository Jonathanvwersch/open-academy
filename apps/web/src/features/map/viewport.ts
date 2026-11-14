import { getViewportForBounds } from '@xyflow/react';
import type { GroupNode } from './layout.js';

export const mapFitViewOptions = { padding: 0.1, minZoom: 0.01, maxZoom: 1 };

export function groupJumpView(group: GroupNode, width: number, height: number) {
  const bounds = {
    ...group.position,
    width: Number(group.style?.width),
    height: Number(group.style?.height),
  };
  if (!(width > 0 && height > 0 && bounds.width > 0 && bounds.height > 0)) return undefined;
  const fitted = getViewportForBounds(
    bounds,
    width,
    height,
    mapFitViewOptions.minZoom,
    mapFitViewOptions.maxZoom,
    mapFitViewOptions.padding,
  );
  if (fitted.zoom < 0.8)
    return {
      kind: 'anchor' as const,
      viewport: { x: 24 - bounds.x * 0.8, y: 24 - bounds.y * 0.8, zoom: 0.8 },
    };
  return { kind: 'fit' as const, bounds };
}

export function initialMapViewport(groups: GroupNode[], width: number, height: number) {
  const first = groups[0];
  if (!first || width <= 0 || height <= 0) return undefined;
  const zoom = width < 640 ? 0.8 : 0.9;
  return {
    x: 24 - first.position.x * zoom,
    y: 24 - first.position.y * zoom,
    zoom,
  };
}
