import { getNodesBounds, getViewportForBounds } from '@xyflow/react';
import type { GroupNode } from './layout.js';

export const mapFitViewOptions = { padding: 0.15, minZoom: 0.75, maxZoom: 1 };

export function initialMapViewport(groups: GroupNode[], width: number, height: number) {
  const first = groups[0];
  if (!first || width <= 0 || height <= 0) return undefined;
  const bounds = getNodesBounds(
    groups.map((group) => ({
      ...group,
      width: Number(group.style?.width),
      height: Number(group.style?.height),
    })),
  );
  const viewport = getViewportForBounds(bounds, width, height, 0.75, 1, 0.15);
  if (bounds.width * viewport.zoom > width || bounds.height * viewport.zoom > height)
    return {
      x: 24 - first.position.x * viewport.zoom,
      y: 24 - first.position.y * viewport.zoom,
      zoom: viewport.zoom,
    };
  return viewport;
}
