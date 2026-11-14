import type { GroupNode } from './layout.js';

export const mapFitViewOptions = { padding: 0.1, minZoom: 0.01, maxZoom: 1 };

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
