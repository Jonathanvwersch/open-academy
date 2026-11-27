import { expect, test } from 'vitest';
import { httpRequestFor, type SimulatorOperation } from './driver.js';

test('continueActivity HTTP requests preserve an optional body', () => {
  const path = '/sessions/session/activities/activity/continue';
  const withBody: SimulatorOperation = {
    kind: 'continueActivity',
    sessionId: 'session',
    activityId: 'activity',
    body: { after: 'final' },
  };
  const withoutBody: SimulatorOperation = {
    kind: 'continueActivity',
    sessionId: 'session',
    activityId: 'activity',
    body: undefined,
  };

  expect(httpRequestFor(withBody)).toEqual({
    method: 'POST',
    path,
    body: { after: 'final' },
  });
  expect(httpRequestFor(withoutBody)).toEqual({ method: 'POST', path });
});
