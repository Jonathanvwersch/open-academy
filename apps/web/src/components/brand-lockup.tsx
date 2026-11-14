import { Logo } from './ui/logo.js';

export function BrandLockup() {
  return (
    <span className="inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap text-primary">
      <Logo className="size-7" />
      <span className="font-heading text-[1.375rem] leading-none font-medium tracking-tight">
        Open Academy
      </span>
    </span>
  );
}
