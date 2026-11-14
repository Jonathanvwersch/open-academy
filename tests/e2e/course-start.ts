import { eq } from 'drizzle-orm';
import type { Database } from '../../apps/api/src/db/client.js';
import { courseEnrollments, users } from '../../apps/api/src/db/schema.js';

export async function enrollInDefaultCourse(db: Database, userId: string) {
  const courseId =
    process.env.PLAYWRIGHT_CONTENT_DIR === 'content' ? 'ml-foundations' : 'fixture-course';
  await db.update(users).set({ activeCourseId: courseId }).where(eq(users.id, userId));
  await db.insert(courseEnrollments).values({
    userId,
    courseId,
    status: 'active',
    startMethod: 'beginning',
  });
}
