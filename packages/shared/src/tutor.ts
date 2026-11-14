export const TUTOR_QUESTION_MAX_LENGTH = 8000;

export function tutorQuestionTooLongMessage(): string {
  return `Your message is too long. The limit is ${TUTOR_QUESTION_MAX_LENGTH.toLocaleString('en-US')} characters.`;
}

function repairMathControlCharacters(markdown: string): string {
  return markdown.replace(
    /\$\$([\s\S]*?)\$\$|\$(?!\$)([\s\S]*?)\$(?!\$)/g,
    (match, displayMath: string | undefined, inlineMath: string | undefined) => {
      const delimiterLength = match.startsWith('$$') ? 2 : 1;
      const delimiter = '$'.repeat(delimiterLength);
      const content = displayMath ?? inlineMath ?? '';
      let repaired = content
        .replace(/\t([A-Za-z])/g, (_match, letter: string) => `\\t${letter}`)
        .replace(
          /\n(abla|leq|geq|mid|neq|eq|eg|ot)(?![A-Za-z])/g,
          (_match, command: string) => `\\n${command}`,
        );
      if (delimiterLength === 1) {
        repaired = repaired.replace(
          /\n(u|e|i)(?![A-Za-z])/g,
          (_match, command: string) => `\\n${command}`,
        );
      }
      return `${delimiter}${repaired}${delimiter}`;
    },
  );
}

function repairBacktickedMath(markdown: string): string {
  return markdown
    .split('```')
    .map((segment, index) => {
      if (index % 2 === 1) return segment;
      return segment
        .replace(/(?<!`)`(\$[^$`\n]+\$)`(?!`)/g, '$1')
        .replace(/(?<!`)`([^`\n]+)`(?!`)/g, (match, content: string) => {
          const latexCommand = /\\[A-Za-z]{2,}/.test(content);
          const numericExpression = /^(?=.*\d)[0-9 ,.\/+^()-]+$/.test(content);
          return latexCommand || numericExpression ? `$${content}$` : match;
        });
    })
    .join('```');
}

export function repairTutorMarkdown(md: string): string {
  const repaired = md
    .replace(/([\s\S])([0-9a-fA-F]{2})/g, (match, control: string, hex: string) => {
      const code = control.charCodeAt(0);
      return code >= 1 && code <= 8
        ? String.fromCodePoint(code * 0x100 + Number.parseInt(hex, 16))
        : match;
    })
    .replace(/([\r\f\b])([A-Za-z])/g, (_match, control: string, letter: string) => {
      const command = control === '\r' ? 'r' : control === '\f' ? 'f' : 'b';
      return `\\${command}${letter}`;
    });
  const repairedMath = repairMathControlCharacters(repaired)
    .replace(/[\s\S]/g, (character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f)
        ? ''
        : character;
    })
    .replace(/(?<!\$)\$\$([^$\n]+)\$(?!\$)/g, (_match, math: string) => `$${math}$`);
  return repairBacktickedMath(repairedMath);
}
