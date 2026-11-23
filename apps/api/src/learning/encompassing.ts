import type { ContentIndex } from '../content/types.js';

export interface EncompassingIndex {
  weight(conceptId: string, ancestorId: string): number;
  ancestors(conceptId: string): Map<string, number>;
  descendants(conceptId: string): Map<string, number>;
}

const indexes = new WeakMap<ContentIndex, EncompassingIndex>();

export function buildEncompassingIndex(content: ContentIndex): EncompassingIndex {
  const cached = indexes.get(content);
  if (cached) return cached;

  const weightsByConcept = new Map<string, Map<string, number>>();
  const building = new Set<string>();

  const weightsFor = (conceptId: string): Map<string, number> => {
    const cachedWeights = weightsByConcept.get(conceptId);
    if (cachedWeights) return cachedWeights;

    const weights = new Map([[conceptId, 1]]);
    weightsByConcept.set(conceptId, weights);
    if (building.has(conceptId)) return weights;

    const concept = content.conceptsById.get(conceptId);
    if (!concept) return weights;
    building.add(conceptId);
    const explicit = new Map((concept.encompassings ?? []).map(({ id, weight }) => [id, weight]));
    for (const prerequisite of concept.prereqs) {
      if (prerequisite.strength === 'hard' && !explicit.has(prerequisite.id)) {
        explicit.set(prerequisite.id, 0.5);
      }
    }

    for (const [ancestorId, weight] of explicit) weights.set(ancestorId, weight);
    for (const [encompassedId, edgeWeight] of explicit) {
      for (const [ancestorId, pathWeight] of weightsFor(encompassedId)) {
        if (ancestorId === encompassedId || explicit.has(ancestorId)) continue;
        const inferredWeight = edgeWeight * pathWeight;
        if (inferredWeight > (weights.get(ancestorId) ?? 0)) {
          weights.set(ancestorId, inferredWeight);
        }
      }
    }
    building.delete(conceptId);
    return weights;
  };

  for (const concept of content.concepts) weightsFor(concept.id);

  const ancestorsByConcept = new Map<string, Map<string, number>>();
  const descendantsByConcept = new Map<string, Map<string, number>>();
  for (const [conceptId, weights] of weightsByConcept) {
    const ancestors = new Map(
      [...weights].filter(([ancestorId, weight]) => ancestorId !== conceptId && weight > 0),
    );
    ancestorsByConcept.set(conceptId, ancestors);
    for (const [ancestorId, weight] of ancestors) {
      const descendants = descendantsByConcept.get(ancestorId) ?? new Map<string, number>();
      descendants.set(conceptId, weight);
      descendantsByConcept.set(ancestorId, descendants);
    }
  }

  const index: EncompassingIndex = {
    weight: (conceptId, ancestorId) =>
      conceptId === ancestorId ? 1 : (ancestorsByConcept.get(conceptId)?.get(ancestorId) ?? 0),
    ancestors: (conceptId) => ancestorsByConcept.get(conceptId) ?? new Map(),
    descendants: (conceptId) => descendantsByConcept.get(conceptId) ?? new Map(),
  };
  indexes.set(content, index);
  return index;
}
