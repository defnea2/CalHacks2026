// Right-side drawer on the teacher dashboard with a student's profile. Esc / × / backdrop close.
import { useEffect, useRef } from 'react';
import type { DbConnection } from '../module_bindings';
import { StudentProfile } from './StudentProfile';
import { CloseIcon, ProfileIcon } from '../brand/icons';

export function ProfileDrawer({ conn, learnerId, teacherId, name, onClose }: { conn: DbConnection; learnerId: bigint; teacherId: bigint; name?: string; onClose: () => void }) {
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', on);
    asideRef.current?.focus();
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="db-profile-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <aside ref={asideRef} tabIndex={-1} className="db-profile-drawer" data-testid="profile-drawer" role="dialog" aria-modal="true" aria-label={`Profile of ${name ?? 'student'}`}>
        <div className="db-profile-bar">
          <span className="pr-eyebrow db-profile-eyebrow"><ProfileIcon size={16} />Student profile</span>
          <button className="db-profile-close" data-testid="profile-close" aria-label="Close profile" onClick={onClose}>
            <CloseIcon size={20} />
          </button>
        </div>
        <StudentProfile key={learnerId.toString()} conn={conn} learnerId={learnerId} teacherId={teacherId} fallbackName={name} />
      </aside>
    </div>
  );
}
