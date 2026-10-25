import "./buddy.css";

/** Pip, the tutor's mascot: a friendly blob that blinks, bobs and waves. Decorative only. */
export function Buddy({ size = 96, wave = false, className = "" }: { size?: number; wave?: boolean; className?: string }) {
  return <svg className={`buddy ${wave ? "buddy-wave" : ""} ${className}`} width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
    <ellipse className="buddy-shadow" cx="60" cy="112" rx="30" ry="5" />
    <g className="buddy-body">
      <path d="M60 14c26 0 44 20 44 46 0 27-17 44-44 44S16 87 16 60c0-26 18-46 44-46z" fill="var(--color-accent)" stroke="var(--color-outline)" strokeWidth="4" />
      <path d="M38 30c8-7 20-9 30-6" fill="none" stroke="var(--cream-50)" strokeWidth="5" strokeLinecap="round" opacity=".55" />
      <g className="buddy-eyes">
        <ellipse cx="46" cy="56" rx="6" ry="8" fill="var(--color-outline)" />
        <ellipse cx="74" cy="56" rx="6" ry="8" fill="var(--color-outline)" />
        <circle cx="48" cy="53" r="2" fill="var(--cream-50)" />
        <circle cx="76" cy="53" r="2" fill="var(--cream-50)" />
      </g>
      <circle cx="36" cy="70" r="6" fill="var(--berry-500)" opacity=".35" />
      <circle cx="84" cy="70" r="6" fill="var(--berry-500)" opacity=".35" />
      <path d="M50 72q10 9 20 0" fill="none" stroke="var(--color-outline)" strokeWidth="4" strokeLinecap="round" />
      <path className="buddy-arm" d="M100 62q14-6 12-22" fill="none" stroke="var(--color-outline)" strokeWidth="4" strokeLinecap="round" />
      <path d="M58 14q2-10 10-10" fill="none" stroke="var(--color-outline)" strokeWidth="4" strokeLinecap="round" />
      <circle cx="69" cy="5" r="4" fill="var(--color-highlight)" stroke="var(--color-outline)" strokeWidth="3" />
    </g>
  </svg>;
}

/** Loading state with the mascot hopping above three bouncing dots. */
export function LoadingBuddy({ label }: { label: string }) {
  return <div className="loading-buddy" role="status">
    <Buddy size={72} />
    <span className="loading-dots" aria-hidden="true"><i /><i /><i /></span>
    <span>{label}</span>
  </div>;
}
