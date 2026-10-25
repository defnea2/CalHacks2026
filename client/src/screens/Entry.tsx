// Entry page: choose a role. No accounts: students and teachers are picked or created freely.
import { navigate, routeUrl } from '../lib/format';
import { TutorAvatar } from '../components/TutorAvatar';

export function Entry() {
  const go = (k: 'student' | 'teacher') => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(routeUrl({ [k]: '' }));
  };
  return (
    <div data-testid="entry-screen">
      <section className="pr-intro" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24 }}>
        <div>
          <span className="pr-eyebrow">Math tutor for ages 8–12</span>
          <h1>Let's think it through,<br />one picture at a time.</h1>
          <p>Talk or type with a tutor that explains with moving pictures. Teachers can run a whole class and watch every student learn.</p>
        </div>
        <TutorAvatar state="idle" size={92} label="The tutor says hello" />
      </section>
      <div className="pr-options" role="list">
        <a role="listitem" className="pr-option" href={routeUrl({ student: '' })} onClick={go('student')} data-testid="role-student">
          <span className="pr-option-top"><span>Student</span><span>Learn</span></span>
          <StudentSketch />
          <h2>I'm a student</h2>
          <p>Get help with a task on your own, or wait until your teacher starts the class.</p>
          <span className="pr-option-link"><span>Start learning</span><span aria-hidden="true">→</span></span>
        </a>
        <a role="listitem" className="pr-option" href={routeUrl({ teacher: '' })} onClick={go('teacher')} data-testid="role-teacher">
          <span className="pr-option-top"><span>Teacher</span><span>Lead a class</span></span>
          <TeacherSketch />
          <h2>I'm a teacher</h2>
          <p>Set learning goals and how to teach, start a class session and follow every student on one dashboard.</p>
          <span className="pr-option-link"><span>Set up a class</span><span aria-hidden="true">→</span></span>
        </a>
      </div>
    </div>
  );
}

function StudentSketch() {
  return (
    <svg viewBox="0 0 260 110" className="pr-sketch" aria-hidden="true">
      {[0, 1, 2].flatMap(r => [0, 1, 2, 3].map(c => <rect key={`${r}-${c}`} x={70 + c * 32} y={18 + r * 26} width="18" height="16" rx="2" fill={c < 3 ? '#24594b' : '#b8723f'} opacity={c < 3 ? 1 : 0.85} />))}
      <path d="M60 96h150" stroke="currentColor" strokeWidth="1.2" />
      <text x="135" y="108" textAnchor="middle" fontSize="12" fill="currentColor">3 × 4 = 12</text>
    </svg>
  );
}

function TeacherSketch() {
  return (
    <svg viewBox="0 0 260 110" className="pr-sketch" aria-hidden="true">
      {[0, 1].map(row => (
        <g key={row}>
          {[0, 1, 2, 3].map(c => (
            <rect key={c} x={40 + c * 47} y={14 + row * 46} width="38" height="34" rx="2" fill="#fffefa" stroke={row === 0 && c < 2 ? '#24594b' : row === 0 ? '#b8723f' : '#24594b'} strokeWidth="1.5" />
          ))}
          {[0, 1, 2, 3].map(c => <path key={`l${c}`} d={`M${46 + c * 47} ${30 + row * 46}h22 M${46 + c * 47} ${38 + row * 46}h14`} stroke="#9aa59a" strokeWidth="1.5" />)}
        </g>
      ))}
    </svg>
  );
}
