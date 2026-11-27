import type { LessonStore } from '../store/lesson-store.js';

export async function openTargetedReviews(
  store: LessonStore,
  input: {
    learnerId: string;
    conceptId: string;
    prerequisiteIds: readonly string[];
    attemptId: string | null;
    now: Date;
  },
) {
  if (!input.prerequisiteIds.length) return;
  const existing = await store.listRemediationFlags(input.learnerId, {
    conceptId: input.conceptId,
    targetPrereqIds: input.prerequisiteIds,
  });
  const alreadyOpen = new Set(
    existing
      .filter(
        (flag) =>
          flag.status === 'open' ||
          (input.attemptId !== null && flag.openedByAttemptId === input.attemptId),
      )
      .map((flag) => flag.targetPrereqId),
  );
  await store.insertRemediationFlags(
    input.learnerId,
    input.prerequisiteIds
      .filter((id) => !alreadyOpen.has(id))
      .map((targetPrereqId) => ({
        conceptId: input.conceptId,
        targetPrereqId,
        openedByAttemptId: input.attemptId,
        status: 'open',
        createdAt: input.now,
        resolvedAt: null,
      })),
  );
}
