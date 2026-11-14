import { describe, expect, it } from 'vitest';
import { OpenAIProvider } from '../../src/features/tutor/provider.js';

describe('live OpenAI tutor smoke', () => {
  it.skipIf(!process.env.OPENAI_API_KEY)(
    'returns the strict tutor schema',
    async () => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return;
      const provider = new OpenAIProvider(apiKey, process.env.OPENAI_MODEL ?? 'gpt-5.4-mini');
      const reply = await provider.respond(
        {
          conceptTitle: 'Linear regression',
          objectives: ['Interpret a slope.'],
          lessonSummary: 'A line predicts a continuous value.',
          exercisePrompt: 'What does the slope mean?',
          exerciseLabel: 'Question 1',
          exerciseOptions: [],
          answerKey: '',
          learnerAnswer: 'The intercept.',
          graderVerdict: 'Incorrect.',
          graderFeedback: '',
          hintLevel: 1,
          authoredHints: ['Compare output changes.'],
          solution: 'The slope is the predicted change per unit.',
          recentMistakes: [],
          history: [],
          problem_status: 'unanswered',
          page: 'none',
          page_content: '',
        },
        'nudge',
      );
      expect(reply.value.message_md.length).toBeGreaterThan(0);
      expect(reply.value.suggests_review_of).toEqual(expect.any(Array));
    },
    30_000,
  );
});
