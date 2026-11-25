import { effectiveGrantStates } from '@academy/aesop/placement/grants';
import { and, eq, notInArray } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { placementGrants } from '../../db/schema.js';

export async function confirmedPlacementTopicIds(
  db: Database,
  userId: string,
): Promise<ReadonlySet<string>> {
  const grants = await db
    .select({
      conceptId: placementGrants.conceptId,
      state: placementGrants.state,
      createdAt: placementGrants.createdAt,
    })
    .from(placementGrants)
    .where(
      and(
        eq(placementGrants.userId, userId),
        notInArray(placementGrants.reason, ['legacy_confirmed', 'legacy_provisional']),
      ),
    );
  return new Set(
    [...effectiveGrantStates(grants)]
      .filter(([, state]) => state === 'confirmed')
      .map(([id]) => id),
  );
}
