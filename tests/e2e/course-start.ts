import { eq } from 'drizzle-orm';
import { loadContent } from '../../apps/api/src/content/load.js';
import type { Database } from '../../apps/api/src/db/client.js';
import { courseEnrollments, lessonRuns, users } from '../../apps/api/src/db/schema.js';

let contentPromise: ReturnType<typeof loadContent> | undefined;

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

export async function markProjectPrerequisitesDone(
  db: Database,
  userId: string,
  projectId: string,
) {
  const directory = process.env.PLAYWRIGHT_CONTENT_DIR ?? 'tests/fixtures/content';
  if (!contentPromise) contentPromise = loadContent(directory);
  const content = await contentPromise;
  const project = content.projectsById.get(projectId);
  if (!project) throw new Error(`Missing project ${projectId}`);

  const done = new Set<string>();
  const visit = (conceptId: string) => {
    if (done.has(conceptId)) return;
    done.add(conceptId);
    const concept = content.conceptsById.get(conceptId);
    if (!concept) throw new Error(`Missing project prerequisite ${conceptId}`);
    for (const prerequisite of concept.prereqs) {
      if (prerequisite.strength === 'hard') visit(prerequisite.id);
    }
  };
  for (const prerequisiteId of project.prereqs) visit(prerequisiteId);

  await db.insert(lessonRuns).values(
    [...done].map((conceptId) => ({
      userId,
      conceptId,
      status: 'completed' as const,
    })),
  );
}
