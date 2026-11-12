export const TUTOR_QUESTION_MAX_LENGTH = 8000;

export function tutorQuestionTooLongMessage(): string {
  return `Your message is too long. The limit is ${TUTOR_QUESTION_MAX_LENGTH.toLocaleString('en-US')} characters.`;
}
