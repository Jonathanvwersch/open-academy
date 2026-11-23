import type { ContentIndex } from '../src/content/types.js';

export function withStubConcept(content: ContentIndex, conceptId: string): ContentIndex {
  const concept = content.conceptsById.get(conceptId);
  if (!concept) throw new Error(`Missing concept ${conceptId}`);

  const stub = { ...concept, status: 'stub' as const };
  const concepts = content.concepts.map((candidate) =>
    candidate.id === conceptId ? stub : candidate,
  );

  return {
    ...content,
    concepts,
    conceptsById: new Map(content.conceptsById).set(conceptId, stub),
  };
}

export function hardPrerequisiteAncestors(content: ContentIndex, conceptId: string): Set<string> {
  const ancestors = new Set<string>();
  const visited = new Set([conceptId]);
  const visit = (currentId: string) => {
    const concept = content.conceptsById.get(currentId);
    if (!concept) return;
    for (const prerequisite of concept.prereqs) {
      if (prerequisite.strength !== 'hard' || visited.has(prerequisite.id)) continue;
      visited.add(prerequisite.id);
      ancestors.add(prerequisite.id);
      visit(prerequisite.id);
    }
  };
  visit(conceptId);
  return ancestors;
}
