export const TUTOR_QUESTION_MAX_LENGTH = 8000;

export function tutorQuestionTooLongMessage(): string {
  return `Your message is too long. The limit is ${TUTOR_QUESTION_MAX_LENGTH.toLocaleString('en-US')} characters.`;
}

export function repairTutorMarkdown(md: string): string {
  return md
    .replace(/([\s\S])([0-9a-fA-F]{2})/g, (match, control: string, hex: string) => {
      const code = control.charCodeAt(0);
      return code >= 1 && code <= 8
        ? String.fromCodePoint(code * 0x100 + Number.parseInt(hex, 16))
        : match;
    })
    .replace(/[\s\S]/g, (character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)
        ? ''
        : character;
    })
    .replace(/(?<!\$)\$\$([^$\n]+)\$(?!\$)/g, (_match, math: string) => `$${math}$`)
    .replace(/(?<!`)`(\$[^$`\n]+\$)`(?!`)/g, '$1');
}
