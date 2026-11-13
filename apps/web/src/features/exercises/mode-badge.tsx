import { Badge } from '../../components/ui/badge.js';
export function ModeBadge({ mode }: { mode: 'practice' | 'assessment' | 'review' }) {
  return (
    <Badge variant="outline">
      {mode === 'assessment' ? 'Assessment — no help' : mode === 'review' ? 'Review' : 'Practice'}
    </Badge>
  );
}
