// Which SpacetimeDB server and database the operator scripts talk to, plus the guards for a
// non-local (e.g. Maincloud) target. Shared by publish.mjs, stdb-cli.mjs (seed-demo, simulate).
//
//   SPACETIME_SERVER  CLI server nickname or URL (default `local`; `maincloud` = hosted cloud)
//   SPACETIME_DB      database name (default `voice-tutor`)
//
// A non-local target never runs by accident: writes need --yes-remote, and deleting data on it
// (publish --clear) additionally needs --yes-delete-remote-data. --dry-run prints the exact
// commands and runs nothing.

/** `local`, or a loopback URL, is the developer's own server. */
export function isLocalServer(server) {
  return server === 'local' || /^(wss?|https?):\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(server);
}

/** Resolved target from env (process env by default). */
export function resolveTarget(env = process.env) {
  const server = (env.SPACETIME_SERVER || 'local').trim();
  const db = (env.SPACETIME_DB || 'voice-tutor').trim();
  return { server, db, local: isLocalServer(server) };
}

export const REMOTE_FLAG = '--yes-remote';
export const REMOTE_DELETE_FLAG = '--yes-delete-remote-data';

/**
 * Throws unless the target is local, or the run is a dry run, or argv confirms the remote target.
 * `deletesData` (publish --clear) needs the second flag on a remote target too.
 */
export function assertTargetAllowed(target, argv, { action, deletesData = false, dryRun = false } = {}) {
  if (target.local || dryRun) return;
  if (!argv.includes(REMOTE_FLAG)) {
    throw new Error(`${action ?? 'this command'} targets the REMOTE server "${target.server}" (database "${target.db}"). Re-run with ${REMOTE_FLAG} to confirm, or --dry-run to only print the commands.`);
  }
  if (deletesData && !argv.includes(REMOTE_DELETE_FLAG)) {
    throw new Error(`--clear on the REMOTE server "${target.server}" deletes all data of "${target.db}". Add ${REMOTE_DELETE_FLAG} as well if that is really intended.`);
  }
}

/** One-line banner, printed before anything runs. */
export function describeTarget(target) {
  return `target: server=${target.server} db=${target.db}${target.local ? '' : '  [REMOTE]'}`;
}

/** Quotes one argument for display as a POSIX shell word. */
export function shellQuote(a) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`;
}
