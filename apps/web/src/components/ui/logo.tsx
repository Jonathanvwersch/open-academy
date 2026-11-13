export function Logo({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={className}
    >
      <path d="M1 5H7V1.6Z" />
      <path d="M9 1.6V5H15Z" />
      <rect x="2" y="6" width="12" height="1" />
      <rect x="3" y="8" width="1" height="5" />
      <rect x="5" y="8" width="1" height="5" />
      <rect x="10" y="8" width="1" height="5" />
      <rect x="12" y="8" width="1" height="5" />
      <rect x="1" y="14" width="14" height="1" />
    </svg>
  );
}
