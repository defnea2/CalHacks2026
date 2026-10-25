// Screen 2: the live session (?session=<id>; a reload resumes it). Voice and text in one view.
import type { DbConnection } from '../module_bindings';
import type { AppSettings } from '../config';
import { SessionView } from '../session/SessionView';

export function SessionScreen({ conn, sessionId, settings }: { conn: DbConnection; sessionId: bigint; settings: AppSettings }) {
  return <SessionView conn={conn} sessionId={sessionId} settings={settings} />;
}
