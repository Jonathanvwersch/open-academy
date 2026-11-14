/** An open portico: two supporting forms and an uninterrupted central entrance. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" fill="currentColor" className={className}>
      <path d="M3 11 14 4v5l-6 4v14H3ZM29 11 18 4v5l6 4v14h5ZM1 29h30v2H1Z" />
    </svg>
  );
}
