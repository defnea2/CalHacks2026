export function Icon({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 48 48"
      aria-hidden="true"
      className={`lab-icon ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "leaf" ? (
        <>
          <path
            d="M10 35C4 14 25 7 39 8c1 18-9 33-27 28"
            fill="currentColor"
            fillOpacity=".15"
          />
          <path d="M8 41L31 17m-13 13l0-10m4 6l9 0" />
        </>
      ) : name === "sun" ? (
        <>
          <circle cx="24" cy="24" r="9" fill="currentColor" fillOpacity=".18" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
            <path
              key={angle}
              d="M24 3v5"
              transform={`rotate(${angle} 24 24)`}
            />
          ))}
        </>
      ) : name === "cloud" ? (
        <path
          d="M12 34h25a8 8 0 0 0 0-16 13 13 0 0 0-24-2A9 9 0 0 0 12 34Z"
          fill="currentColor"
          fillOpacity=".15"
        />
      ) : name === "drop" ? (
        <>
          <path
            d="M24 5S10 21 10 30a14 14 0 0 0 28 0C38 21 24 5 24 5Z"
            fill="currentColor"
            fillOpacity=".15"
          />
          <path d="M17 30a7 7 0 0 0 7 7" />
        </>
      ) : name === "animal" ? (
        <>
          <path d="M9 19L7 8l13 7m8 0L41 8l-2 11" />
          <ellipse
            cx="24"
            cy="29"
            rx="17"
            ry="14"
            fill="currentColor"
            fillOpacity=".12"
          />
          <circle cx="17" cy="26" r="1" />
          <circle cx="31" cy="26" r="1" />
          <path d="M21 33l3 3 3-3" />
        </>
      ) : name === "book" ? (
        <>
          <path
            d="M24 13C17 7 8 9 5 11v27c7-3 13-2 19 2 6-4 12-5 19-2V11c-7-3-14-2-19 2Z"
            fill="currentColor"
            fillOpacity=".12"
          />
          <path d="M24 13v27" />
        </>
      ) : (
        <>
          <rect
            x="10"
            y="10"
            width="28"
            height="28"
            rx="9"
            fill="currentColor"
            fillOpacity=".13"
          />
          <circle cx="24" cy="24" r="4" fill="currentColor" />
        </>
      )}
    </svg>
  );
}
