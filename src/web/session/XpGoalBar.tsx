import { useEffect, useState } from 'react';
import { Progress } from '../ui/progress.js';

export function XpGoalBar({
  today,
  goal,
  previousToday,
}: {
  today: number;
  goal: number;
  previousToday: number;
}) {
  const safeGoal = Math.max(1, goal);
  const finalProgress = Math.min(100, Math.max(0, (today / safeGoal) * 100));
  const startingProgress = Math.min(100, Math.max(0, (previousToday / safeGoal) * 100));
  const [progress, setProgress] = useState(startingProgress);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setProgress(finalProgress));
    return () => window.cancelAnimationFrame(frame);
  }, [finalProgress]);

  return (
    <Progress
      value={progress}
      aria-label="Today's XP goal"
      className="h-3"
      indicatorClassName="transition-[transform] duration-700 motion-reduce:transition-none"
    />
  );
}
