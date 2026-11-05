import type { ComponentProps, FormHTMLAttributes } from 'react';
import { Button } from '@/ui/button.js';
import { Textarea } from '@/ui/textarea.js';
import { cn } from '@/lib/utils.js';

export type PromptInputProps = Omit<FormHTMLAttributes<HTMLFormElement>, 'onSubmit'> & {
  onSubmit: FormHTMLAttributes<HTMLFormElement>['onSubmit'];
};

export function PromptInput({ className, ...props }: PromptInputProps) {
  return <form className={cn('space-y-2', className)} {...props} />;
}

export type PromptInputTextareaProps = ComponentProps<typeof Textarea>;

export function PromptInputTextarea({ className, ...props }: PromptInputTextareaProps) {
  return <Textarea className={cn('min-h-24 w-full', className)} {...props} />;
}

export type PromptInputSubmitProps = ComponentProps<typeof Button>;

export function PromptInputSubmit({ children, ...props }: PromptInputSubmitProps) {
  return (
    <Button aria-label="Send" type="submit" {...props}>
      {children ?? 'Send'}
    </Button>
  );
}
