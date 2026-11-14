/** A quiet tortoise mark for learning assistance, distinct from the academy logo. */
export function TortoiseMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={className} fill="none">
      <g fill="#7f8958">
        <path d="M7 22 6 27H11L12 23M21 22 22 27H27L25 21" />
        <path d="M22 19V17C22 14 24 12 27 12S31 14 31 17V20C31 23 28 24 24 24H21" />
        <path d="M3 22C3 13 7 6 14 6S26 13 26 22Q15 27 3 22Z" />
      </g>
      <path
        d="m14 10 6 4v7l-6 3-6-3v-7ZM14 6v4M8 14l-4-1M20 14l4-1"
        stroke="#d9dec7"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}
