// Accounts and passwordless sign-in (docs/ARCHITECTURE.md "Identity and authorization").
// Shared by the module (spacetimedb/src/auth.ts) and the client.
//
// - Every browser keeps its SpacetimeDB token (localStorage), so a device has one stable identity.
// - An account (learner or teacher) is owned by the identities linked to it in the private
//   table account_link: the creating device, plus every device that redeemed a sign-in code.
// - A sign-in code is short, one-time and expires; only its hash is stored.

export const ACCOUNT_KINDS = ['learner', 'teacher'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const AUTH_DEFAULTS = {
  /** Characters of a sign-in code (no 0/O, 1/I/L). */
  CODE_ALPHABET: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  CODE_LENGTH: 6,
  /** "Sign in on another device" from an owning device (teacher or student). */
  DEVICE_CODE_TTL_S: 10 * 60,
  /** A teacher's code for one of their students (handed out in class). */
  STUDENT_CODE_TTL_S: 24 * 60 * 60,
  /** Codes printed by operator scripts (seed-demo, sign-in-code). */
  OPERATOR_CODE_TTL_S: 7 * 24 * 60 * 60,
  /** Wrong codes per identity inside one window before linkDevice refuses for the rest of it. */
  MAX_FAILED_ATTEMPTS: 8,
  ATTEMPT_WINDOW_S: 10 * 60,
  /** Live codes per account (older ones are dropped when a new one is issued). */
  MAX_LIVE_CODES_PER_ACCOUNT: 3,
} as const;

/** Uppercase, without spaces and dashes (codes are typed by children: "k7q 2m9" works). */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

/** "K7Q2M9" -> "K7Q-2M9" for display. */
export function formatCode(code: string): string {
  const c = normalizeCode(code);
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

/** Result of the issueSignInCode procedure (JSON). */
export type IssueCodeResult =
  | { ok: true; code: string; kind: AccountKind; accountId: string; name: string; expiresMs: number }
  | { ok: false; error: string };

/** Messages the client shows as they are (module SenderError texts). */
export const AUTH_ERRORS = {
  learnerOtherDevice: 'This student belongs to another device. Ask your teacher for a code.',
  teacherOtherDevice: 'This teacher account belongs to another device. Get a sign-in code on that device.',
  simulated: 'Simulated students are run by the class simulation.',
  sessionOtherDevice: 'This lesson belongs to another device.',
  classOtherTeacher: 'This class belongs to another teacher.',
  notYourStudent: 'This student is not in one of your classes.',
  badCode: 'That code is not valid or has expired.',
  tooManyAttempts: 'Too many wrong codes. Wait a few minutes and try again.',
} as const;
