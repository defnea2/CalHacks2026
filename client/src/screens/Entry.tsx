// Entry page: continue as an account of this device, choose a role (create an account there), or
// sign in with a code. Passwordless: accounts belong to devices (docs/ARCHITECTURE.md "Identity and
// authorization").
import type { DbConnection } from '../module_bindings';
import { navigate, routeUrl } from '../lib/format';
import { LogoMark, Wordmark } from '../brand/Logo';
import { useAccounts } from '../stdb/useAccounts';
import { CodeForm } from '../components/SignIn';

function ContinueAs({ conn }: { conn: DbConnection }) {
  const acc = useAccounts(conn);
  const people = [
    ...acc.learners.filter(l => !l.isSimulated).map(l => ({ key: `l${l.id}`, name: l.name, role: 'Student', url: routeUrl({ student: l.id }) })),
    ...acc.teachers.map(t => ({ key: `t${t.id}`, name: t.name, role: 'Teacher', url: routeUrl({ teacher: t.id }) })),
  ];
  return (
    <div className="pr-split" style={{ marginTop: 28 }} data-testid="entry-accounts">
      <div>
        <div className="pr-section-label"><h2>On this device</h2><span>{people.length}</span></div>
        <div className="pr-people">
          {acc.ready && people.length === 0 && <p className="pr-empty">Nobody has signed in on this device yet. Pick a role above, or use a code.</p>}
          {people.map(p => (
            <button key={p.key} className="pr-person" data-testid="continue-as" data-name={p.name} onClick={() => navigate(p.url)}>
              <span><strong>Continue as {p.name}</strong><small>{p.role}</small></span>
            </button>
          ))}
        </div>
      </div>
      <CodeForm conn={conn} />
    </div>
  );
}

export function Entry({ conn }: { conn?: DbConnection | null }) {
  const go = (k: 'student' | 'teacher') => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(routeUrl({ [k]: '' }));
  };
  return (
    <div data-testid="entry-screen">
      <section className="pr-intro" style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 24 }}>
        <div>
          <Wordmark size={44} mark={false} className="pr-hero-wordmark" />
          <span className="pr-eyebrow" style={{ display: 'block', marginTop: 14 }}>Voice math tutor for ages 8–12</span>
          <h1>Let's think it through,<br />one picture at a time.</h1>
          <p>Talk with a tutor that explains with moving pictures. Teachers can run a whole class and watch every student learn.</p>
        </div>
        <LogoMark size={148} title="Fibonacci golden spiral" className="pr-hero-mark" />
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
      {conn && <ContinueAs conn={conn} />}
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
