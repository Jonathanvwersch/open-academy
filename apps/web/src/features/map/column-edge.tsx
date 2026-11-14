import { BaseEdge, type EdgeProps, getSmoothStepPath } from '@xyflow/react';
import type { ColumnEdge } from './layout.js';

export function ColumnGraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps<ColumnEdge>) {
  const options = {
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    centerX: data?.centerX,
    offset: 0,
  };
  let [path] = getSmoothStepPath(options);
  if (data?.corridorY !== undefined && data.targetCenterX !== undefined) {
    const waypointX = data.targetCenterX - 16;
    const [start] = getSmoothStepPath({
      ...options,
      targetX: waypointX,
      targetY: data.corridorY,
    });
    const [end] = getSmoothStepPath({
      ...options,
      sourceX: waypointX,
      sourceY: data.corridorY,
      centerX: data.targetCenterX,
    });
    path = start + end.replace(/^M/, 'L');
  }
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}
