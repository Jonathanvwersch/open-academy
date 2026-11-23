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
