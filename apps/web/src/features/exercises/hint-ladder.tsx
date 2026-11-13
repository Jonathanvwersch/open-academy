import type { RefObject } from 'react';
import { useState } from 'react';
import { apiFetch } from '../../api/authenticated-fetch.js';
import { Button } from '../../components/ui/button.js';
export function HintLadder({
  exerciseId,
  activityId,
  hintCount = 0,
  tutorEnabled = false,
  onHint,
  mode = 'practice',
  buttonRef,
}: {
  exerciseId: string;
  activityId?: string;
  hintCount?: number;
  tutorEnabled?: boolean;
  onHint: (result: {
    level: number;
    text: string;
    revealedSolution: boolean;
    tutorUnavailable?: boolean;
  }) => void;
  mode?: 'practice' | 'review';
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState(0);
  const [solutionShown, setSolutionShown] = useState(false);
  const [hasMore, setHasMore] = useState(tutorEnabled);
  const canRequestHint = level < hintCount || (tutorEnabled && hasMore);
  const showSolution = !canRequestHint;
  const requestHint = async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/hints', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          exerciseId,
          activityId,
          mode,
          stuck: mode === 'review',
          revealSolution: showSolution,
        }),
      });
      const data = await response.json();
      if (response.ok) {
        if (data.revealedSolution) {
          onHint(data);
          setSolutionShown(true);
        } else if (typeof data.text === 'string' || data.tutorUnavailable) {
          onHint({ ...data, text: data.text ?? '' });
          setLevel(data.level ?? hintCount);
          setHasMore(Boolean(data.hasMore));
        } else {
          setLevel(hintCount);
          setHasMore(false);
        }
      }
    } finally {
      setLoading(false);
    }
  };
  if (solutionShown) return null;
  return (
    <Button
      ref={buttonRef}
      type="button"
      loading={loading}
      onClick={requestHint}
      variant="outline"
      size="sm"
    >
      {showSolution ? 'Show solution' : mode === 'review' ? 'Show a hint' : 'Hint'}
    </Button>
  );
}
