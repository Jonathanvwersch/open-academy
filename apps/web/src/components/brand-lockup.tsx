import { Logo } from './ui/logo.js';

export function BrandLockup({
  hideNameWhenSidebarCollapsed = false,
}: {
  hideNameWhenSidebarCollapsed?: boolean;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap text-primary ${
        hideNameWhenSidebarCollapsed ? 'group-data-[collapsible=icon]:gap-0' : ''
      }`}
    >
      <Logo
        className={`size-7 ${
          hideNameWhenSidebarCollapsed ? 'group-data-[collapsible=icon]:size-6' : ''
        }`}
      />
      <span
        className={`font-heading text-[1.375rem] leading-none font-medium tracking-tight ${
          hideNameWhenSidebarCollapsed ? 'group-data-[collapsible=icon]:hidden' : ''
        }`}
      >
        Open Academy
      </span>
    </span>
  );
}
