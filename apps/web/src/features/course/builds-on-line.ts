import type { CoursePayload } from '@academy/aesop/api/course';

type BuildsOnCourse = CoursePayload['buildsOn'][number];

export interface BuildsOnLineItem extends BuildsOnCourse {
  separator: string;
  suffix: string;
}

export function buildsOnLineItems(buildsOn: readonly BuildsOnCourse[]): BuildsOnLineItem[] {
  return buildsOn.map((course, index) => ({
    ...course,
    separator: separatorBefore(index, buildsOn.length),
    suffix:
      course.remaining === 0
        ? 'done'
        : `${course.remaining} of ${course.topicCount} ${course.topicCount === 1 ? 'topic' : 'topics'} left`,
  }));
}

export function buildsOnLineText(buildsOn: readonly BuildsOnCourse[]): string {
  if (buildsOn.length === 0) return "Doesn't need any other course.";
  const items = buildsOnLineItems(buildsOn);
  return `Builds on ${items.map((item) => `${item.separator}${item.title} (${item.suffix})`).join('')}.`;
}

function separatorBefore(index: number, count: number): string {
  if (index === 0) return '';
  if (count === 2) return ' and ';
  return index === count - 1 ? ', and ' : ', ';
}
