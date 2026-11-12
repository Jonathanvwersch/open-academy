import type { ContentIndex } from '../content/types.js';
import type { MasteryRecord } from './types.js';
import { masteryRank } from './types.js';

type LessonRun = {
  conceptId: string;
  status: 'in_progress' | 'needs_retry' | 'quiz' | 'completed';
};

export function masteryKey(conceptId: string, dimension: string): string {
  return `${conceptId}:${dimension}`;
}

export function prerequisiteMet(
  prereqId: string,
  masteryByKey: ReadonlyMap<string, Pick<MasteryRecord, 'state' | 'inferred'>>,
  lessonRuns: readonly LessonRun[],
  content: ContentIndex,
): boolean {
  const concept = content.conceptsById.get(prereqId);
  if (!concept) return false;

  const lessonRun = lessonRuns.find((run) => run.conceptId === prereqId);
  if (lessonRun) return lessonRun.status === 'completed';
  return concept.dimensions.some((dimension) => {
    const record = masteryByKey.get(masteryKey(prereqId, dimension));
    return (
      record?.inferred || masteryRank(record?.state ?? 'not_assessed') >= masteryRank('assisted')
    );
  });
}

export function outlinePosition(conceptId: string, content: ContentIndex): [number, number] {
  let position: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  for (const week of content.curriculum?.weeks ?? []) {
    const index = week.concepts.indexOf(conceptId);
    if (
      index >= 0 &&
      (week.week < position[0] || (week.week === position[0] && index < position[1]))
    ) {
      position = [week.week, index];
    }
  }
  return position;
}

export function compareOutlinePosition(
  leftId: string,
  rightId: string,
  content: ContentIndex,
): number {
  const left = outlinePosition(leftId, content);
  const right = outlinePosition(rightId, content);
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1;
  if (left[1] !== right[1]) return left[1] < right[1] ? -1 : 1;
  return 0;
}
