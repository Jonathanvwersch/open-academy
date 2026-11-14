import type { LessonCourse } from '@academy/contracts/lessons';
import { Link } from '@tanstack/react-router';

export function LessonCourseLine({ course }: { course: LessonCourse | null }) {
  if (!course) return null;
  return (
    <p className="text-base text-muted-foreground" data-testid="lesson-course">
      <Link to="/courses/$courseId" params={{ courseId: course.id }} className="hover:underline">
        {course.title}
      </Link>
      {' · '}
      <span className="whitespace-nowrap">
        Unit {course.unitNumber} · {course.position}
      </span>
    </p>
  );
}
