/** The unnamed academy tortoise, drawn as a vector for crisp rendering at any size. */
export function AcademyMascot({
  celebrating = false,
  className = '',
}: {
  celebrating?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 160 160"
      role="img"
      aria-label={celebrating ? 'Academy tortoise celebrating' : 'Academy tortoise'}
      className={className}
    >
      <ellipse cx="79" cy="137" rx="54" ry="5" fill="#e9e7dd" />
      <g fill="#7d8760" stroke="#515d3d" strokeWidth="2.5" strokeLinejoin="round">
        <path d="M46 105 43 125Q43 130 51 130H60L63 107Z" />
        <path d="M88 107 87 125Q87 130 95 130H103L106 105Z" />
        <path d="M28 101 14 108 33 113Z" />
      </g>
      <g fill="#b9bf91" stroke="#515d3d" strokeWidth="2.5" strokeLinejoin="round">
        <path d="M34 107 29 128Q28 134 37 134H47Q51 134 50 129L51 111Z" />
        <path
          d={
            celebrating
              ? 'M96 108Q112 109 125 99Q132 96 134 102Q137 110 125 117L106 123Z'
              : 'M93 110 95 128Q95 134 103 134H115Q119 133 116 128L110 107Z'
          }
        />
        <path d="M96 95Q108 96 108 82Q109 64 126 64Q144 64 145 81V94Q145 108 128 111L103 117Z" />
      </g>
      <path
        d="M26 105C25 71 39 43 67 43C97 43 114 72 114 105Z"
        fill="#7f8958"
        stroke="#515d3d"
        strokeWidth="3"
      />
      <path
        d="M64 57 84 68 84 91 64 103 45 91 45 68Z M64 57V45 M84 68 100 63 M84 91 112 99 M45 91 27 100 M45 68 34 62"
        fill="none"
        stroke="#b4b990"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d="M26 105Q68 120 114 105L113 113Q68 128 27 113Z"
        fill="#b4b990"
        stroke="#515d3d"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {celebrating ? (
        <path
          d="M125 81Q129 76 133 81"
          fill="none"
          stroke="#333c28"
          strokeWidth="3"
          strokeLinecap="round"
        />
      ) : (
        <ellipse cx="129" cy="80" rx="2.8" ry="3.8" fill="#333c28" />
      )}
      <path
        d="M132 94Q138 98 143 93"
        fill="none"
        stroke="#515d3d"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
