import type { ContentIndex } from '../content/types.js';

export function courseTopicPosition(unitIndex: number, topicIndex: number): string {
  return `${unitIndex + 1}.${topicIndex + 1}`;
}

export function lessonCourseContext(
  content: ContentIndex,
  {
    studyCourseIds,
    conceptId,
    preferredCourseId,
  }: {
    studyCourseIds: readonly string[];
    conceptId: string;
    preferredCourseId?: string;
  },
) {
  const containing = content.courses.filter((course) =>
    course.units.some((unit) => unit.concepts.includes(conceptId)),
  );
  const count = (course: (typeof containing)[number]) =>
    new Set(course.units.flatMap((unit) => unit.concepts)).size;
  const smallest = [...containing].sort((a, b) => count(a) - count(b));
  const course =
    containing.find((course) => course.id === preferredCourseId) ??
    smallest.find((course) => studyCourseIds.includes(course.id)) ??
    smallest[0];
  if (!course) return null;
  const unitIndex = course.units.findIndex((unit) => unit.concepts.includes(conceptId));
  const unit = course.units[unitIndex];
  return {
    courseId: course.id,
    courseTitle: course.title,
    unitNumber: unitIndex + 1,
    unitTitle: unit.title,
    position: courseTopicPosition(unitIndex, unit.concepts.indexOf(conceptId)),
  };
}
