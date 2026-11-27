export type { ImplicitRepetitionTraceEvent } from '../memory/mastery-service.js';
export { setImplicitRepetitionTrace } from '../memory/mastery-service.js';
export type {
  AuditActivityReviewLog,
  AuditMasteryRow,
  AuditPlacementGrantRow,
  AuditReviewCardRow,
  AuditTimedReviewLog,
  SimulatorAudit,
  SimulatorFixtures,
} from './audit.js';
export { runSimulateCli } from './cli.js';
export type {
  ApiResult,
  SimulatedApiFailure,
  SimulatorAfterCall,
  SimulatorDriver,
  SimulatorDriverFactory,
  SimulatorDriverInput,
  SimulatorOperation,
} from './driver.js';
export {
  httpRequestFor,
  QuizClock,
  RequestRandomness,
  SimulatedApiFailureError,
} from './driver.js';
export { answerFor } from './support.js';
