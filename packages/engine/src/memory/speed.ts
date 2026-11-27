export const TOPIC_SPEED_POLICY = 'speed-v1';
export const TOPIC_SPEED_DECAY = 0.8;

export interface TopicSpeedEvidence {
  conceptId: string;
  successes: number;
  trials: number;
  answers: number;
  updatedAt: Date;
  policyVersion: string;
}

export function topicSpeed(
  evidence?: Pick<TopicSpeedEvidence, 'answers' | 'successes' | 'trials'>,
): number {
  if (!evidence || evidence.answers < 3) return 1;
  const accuracy = (evidence.successes + 0.8 * 2) / (evidence.trials + 2);
  const speed = accuracy >= 0.8 ? 1 + (accuracy - 0.8) * 5 : 1 - (0.8 - accuracy) * (0.5 / 0.3);
  return Math.round(Math.max(0.5, Math.min(2, speed)) * 100) / 100;
}
