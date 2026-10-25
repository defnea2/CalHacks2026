// Teacher instructions in the tutor's context (buildContext) for sessions linked to a class
// session. Kept free of other module imports so lesson.ts can use it without cycles.
import type { Ctx, SessionRow } from './ctx';

const DOC_TEXT_MAX = 12_000;

export const isImageMime = (mime: string) => /^image\/(jpeg|png|webp|gif)$/.test(mime);

/** The class block appended to the context, or '' for ad-hoc sessions. */
export function classContextBlock(ctx: Ctx, session: SessionRow): string {
  if (!session.classSessionId) return '';
  const cls = ctx.db.classSession.id.find(session.classSessionId);
  if (!cls) return '';
  const teacher = ctx.db.teacher.id.find(cls.teacherId);
  const lines = [
    '',
    '',
    `Class session (teacher ${teacher?.name ?? 'unknown'}). The teacher's instructions are binding for this lesson.`,
    `Learning goals: ${cls.goals.trim() || '(none given)'}`,
    `Content to cover: ${cls.content.trim() || '(none given)'}`,
    `How to teach (delivery): ${cls.delivery.trim() || '(no special instructions)'}`,
  ];
  if (cls.documentMime) {
    const name = cls.documentName || 'document';
    if (isImageMime(cls.documentMime)) {
      lines.push(`Teacher's document "${name}": an image, attached to your first message of this session.`);
    } else if (cls.documentText.trim()) {
      const text = cls.documentText.length > DOC_TEXT_MAX ? `${cls.documentText.slice(0, DOC_TEXT_MAX)}\n[... truncated]` : cls.documentText;
      lines.push(`Teacher's document "${name}":`, '"""', text, '"""');
    }
  }
  return lines.join('\n');
}

/** True when the session has its own task photo (not only the class document). */
export function hasOwnPhoto(ctx: Ctx, session: SessionRow): boolean {
  return !!ctx.db.sessionImage.sessionId.find(session.id);
}
