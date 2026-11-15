import type { ContentIndex } from './types.js';

export function orderCoursesBySubject<T extends { id: string; subjectId: string }>(
  courses: readonly T[],
  subjects: readonly { id: string }[],
  curriculumCourseIds: readonly string[],
): T[] {
  const subjectOrder = new Map(subjects.map(({ id }, position) => [id, position]));
  const courseOrder = new Map(curriculumCourseIds.map((id, position) => [id, position]));
  return [...courses].sort(
    (left, right) =>
      (subjectOrder.get(left.subjectId) ?? Infinity) -
        (subjectOrder.get(right.subjectId) ?? Infinity) ||
      (courseOrder.get(left.id) ?? Infinity) - (courseOrder.get(right.id) ?? Infinity),
  );
}

export function orderCourseIdsBySubject(
  content: ContentIndex,
  courseIds: readonly string[] = content.courses.map((course) => course.id),
): string[] {
  const courses = courseIds.flatMap((id) => {
    const course = content.coursesById.get(id);
    return course ? [{ id, subjectId: content.subjectForCourse(id).id }] : [];
  });
  return orderCoursesBySubject(
    courses,
    content.curriculum?.subjects ?? [],
    content.curriculum?.courses ?? content.courses.map((course) => course.id),
  ).map(({ id }) => id);
}
