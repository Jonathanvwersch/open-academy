import { getViewportForBounds } from '@xyflow/react';
import type { GroupNode } from './layout.js';

export const mapFitViewOptions = { padding: 0.1, minZoom: 0.01, maxZoom: 0.85 };

export function initialMapViewport(groups: GroupNode[], width: number, height: number) {
  const first = groups[0];
  if (!first || width <= 0 || height <= 0) return undefined;
  if (width < 640) {
    const padding = Math.min(16, width / 10);
    const zoom = Math.min(
      mapFitViewOptions.maxZoom,
      (width - padding * 2) / Number(first.style?.width),
    );
    return {
      x: padding - first.position.x * zoom,
      y: 16 - first.position.y * zoom,
      zoom,
    };
  }
  const x = Math.min(...groups.map((group) => group.position.x));
  const y = Math.min(...groups.map((group) => group.position.y));
  const bounds = {
    x,
    y,
    width: Math.max(...groups.map((group) => group.position.x + Number(group.style?.width))) - x,
    height: Math.max(...groups.map((group) => group.position.y + Number(group.style?.height))) - y,
  };
  return getViewportForBounds(bounds, width, height, 0.01, 0.85, 0.1);
}
