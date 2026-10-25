// The accounts this device is signed in as (module views my_learners / my_teachers /
// my_students / my_roster, filtered by the caller's identity; docs/ARCHITECTURE.md "Identity and
// authorization"). App subscribes once; screens read the rows with useAccounts().
import { createContext, useContext, useEffect, useState } from 'react';
import type { DbConnection } from '../module_bindings';
import type { Learner, Teacher, TeacherStudent } from '../module_bindings/types';
import { subscribe } from './connection';
import { useRows } from './useRows';

export const ACCOUNT_QUERIES = ['SELECT * FROM my_learners', 'SELECT * FROM my_teachers', 'SELECT * FROM my_students', 'SELECT * FROM my_roster'];

/** True once the account views are in the client cache (App level). */
export const AccountsReady = createContext(false);

export function useAccountSubscription(conn: DbConnection | null): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!conn) return;
    setReady(false);
    const sub = subscribe(conn, ACCOUNT_QUERIES, 'accounts');
    sub.ready.then(() => setReady(true)).catch(() => setReady(true));
    return () => sub.unsubscribe();
  }, [conn]);
  return ready;
}

export interface Accounts {
  ready: boolean;
  learners: Learner[];
  teachers: Teacher[];
  students: Learner[];
  roster: TeacherStudent[];
}

const byId = <T extends { id: bigint }>(a: T, b: T) => Number(a.id - b.id);

export function useAccounts(conn: DbConnection): Accounts {
  const ready = useContext(AccountsReady);
  const learners = useRows<Learner>(conn.db.myLearners, () => true, []).sort(byId);
  const teachers = useRows<Teacher>(conn.db.myTeachers, () => true, []).sort(byId);
  const students = useRows<Learner>(conn.db.myStudents, () => true, []).sort(byId);
  const roster = useRows<TeacherStudent>(conn.db.myRoster, () => true, []);
  return { ready, learners, teachers, students, roster };
}
