// Right-side drawer on the teacher dashboard with a student's profile. Esc / × / backdrop close.
import { useEffect, useRef } from 'react';
import type { DbConnection } from '../module_bindings';
import { StudentProfile } from './StudentProfile';

export function ProfileDrawer({ conn, learnerId, teacherId, name, onClose }: { conn: DbConnection; learnerId: bigint; teacherId: bigint; name?: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', on);
    closeRef.current?.focus();
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="db-profile-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside className="db-profile-drawer" data-testid="profile-drawer" role="dialog" aria-modal="true" aria-label={`Profile of ${name ?? 'student'}`}>
        <div className="db-profile-bar">
          <span className="pr-eyebrow">Student profile</span>
          <button ref={closeRef} className="db-profile-close" data-testid="profile-close" aria-label="Close profile" onClick={onClose}>
            ×
          </button>
        </div>
        <StudentProfile key={learnerId.toString()} conn={conn} learnerId={learnerId} teacherId={teacherId} fallbackName={name} />
      </aside>
    </div>
  );
}
