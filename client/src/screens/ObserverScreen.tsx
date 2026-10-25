// Screen 3: read-only mirror of a session (?observe=<id>). Plays nothing; tutor captions and
// canvas reveals follow reply_sentence status `played` (set by the session tab's markPlayed).
// The same <SessionView readOnly /> is what the classroom dashboard embeds to observe a student.
import type { DbConnection } from '../module_bindings';
import { SessionView } from '../session/SessionView';

export function ObserverScreen({ conn, sessionId }: { conn: DbConnection; sessionId: bigint }) {
  return <SessionView conn={conn} sessionId={sessionId} readOnly />;
}
