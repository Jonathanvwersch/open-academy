import type { ComponentProps } from 'react';
import { Markdown } from '../../components/markdown.js';
import { EigenDirections } from './visuals/eigen-directions.js';

export function LessonMarkdown(props: Omit<ComponentProps<typeof Markdown>, 'renderCodeBlock'>) {
  return (
    <Markdown
      {...props}
      renderCodeBlock={({ language, source, meta }) => {
        if (language !== 'svg' || meta?.trim() !== 'academy-visual=eigen-directions')
          return undefined;
        return <EigenDirections fallback={<Markdown>{`\`\`\`svg\n${source}\n\`\`\``}</Markdown>} />;
      }}
    />
  );
}
