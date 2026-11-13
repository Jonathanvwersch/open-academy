import { normalizeDisplayMath } from '@academy/shared/markdown';
import type { ReactNode } from 'react';
import * as React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { cn } from '../lib/utils.js';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';

type DisplayMathNode = {
  type: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: DisplayMathNode[];
  value?: string;
};

function rehypeWrapTutorDisplayMath() {
  return (tree: DisplayMathNode) => {
    const visit = (node: DisplayMathNode) => {
      const code = node.children?.[0];
      const classNames = code?.properties?.className;
      const codeClasses = Array.isArray(classNames)
        ? classNames
        : typeof classNames === 'string'
          ? classNames.split(/\s+/)
          : [];
      if (
        node.tagName === 'pre' &&
        code?.tagName === 'code' &&
        codeClasses.includes('language-math') &&
        codeClasses.includes('math-display')
      ) {
        const tex = (code.children ?? []).map((child) => child.value ?? '').join('');
        if (!tex.includes('\\begin{') && !tex.includes('\\\\')) {
          node.tagName = 'div';
          node.properties = { className: ['tutor-display-math'] };
          node.children = [
            {
              type: 'element',
              tagName: 'code',
              properties: { className: ['language-math', 'math-inline'] },
              children: [{ type: 'text', value: `\\displaystyle ${tex}` }],
            },
          ];
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(tree);
  };
}

export const Markdown = React.memo(function Markdown({
  children,
  inline = false,
  className,
  wrapDisplayMath = false,
}: {
  children: string;
  inline?: boolean;
  className?: string;
  wrapDisplayMath?: boolean;
}) {
  const markdownComponents: Components = {
    code({ className, children: codeChildren, ...props }) {
      if (/\blanguage-svg\b/.test(className ?? '')) {
        const svg = plainText(codeChildren).replace(/\n$/, '');
        const label = svg.match(/\baria-label\s*=\s*["']([^"']+)["']/)?.[1] ?? '';
        return (
          <figure className="my-6 flex max-w-full justify-center">
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
              alt={label}
              className="max-w-full"
              style={{ maxWidth: '70ch' }}
            />
          </figure>
        );
      }
      return (
        <code className={className} {...props}>
          {codeChildren}
        </code>
      );
    },
    pre({ children: preChildren }) {
      const child = React.Children.only(preChildren);
      if (
        React.isValidElement<{ className?: string }>(child) &&
        /language-svg/.test(child.props.className ?? '')
      ) {
        return child;
      }
      return <pre className="overflow-x-auto rounded-lg bg-muted p-4">{preChildren}</pre>;
    },
  };
  const components: Components = inline
    ? {
        ...markdownComponents,
        p({ children: paragraphChildren }) {
          return <span>{paragraphChildren}</span>;
        },
      }
    : markdownComponents;
  const content = (
    <ReactMarkdown
      components={components}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={
        wrapDisplayMath
          ? [rehypeWrapTutorDisplayMath, rehypeKatex, rehypeHighlight]
          : [rehypeKatex, rehypeHighlight]
      }
    >
      {normalizeDisplayMath(children)}
    </ReactMarkdown>
  );
  return inline ? (
    <span className={cn('inline', className)}>{content}</span>
  ) : (
    <div className={cn('markdown max-w-[70ch] text-base leading-7 text-foreground', className)}>
      {content}
    </div>
  );
});

function plainText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(plainText).join('');
  if (React.isValidElement<{ children?: ReactNode }>(children)) {
    return plainText(children.props.children);
  }
  return '';
}
