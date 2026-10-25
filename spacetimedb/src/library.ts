// Content library: loads the lesson pack's seed content into the public read-only tables.
// Reloaded whenever library_meta.packVersion differs from the active pack's version.
import { pack } from '../../shared/src/lesson/index';
import type { Ctx } from './ctx';

const META_ID = 0;

/** Pack version plus a content hash, so edited seed content reloads even without a version bump. */
function libraryVersion(): string {
  const json = JSON.stringify(pack.content);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${pack.version}#${h.toString(16)}`;
}

export function ensureLibrary(ctx: Ctx): boolean {
  const meta = ctx.db.libraryMeta.id.find(META_ID);
  if (meta && meta.packVersion === libraryVersion()) return false;
  loadLibrary(ctx);
  return true;
}

export function loadLibrary(ctx: Ctx): void {
  const db = ctx.db;
  for (const r of [...db.task.iter()]) db.task.key.delete(r.key);
  for (const r of [...db.explanation.iter()]) db.explanation.id.delete(r.id);
  for (const r of [...db.skill.iter()]) db.skill.key.delete(r.key);
  for (const r of [...db.concept.iter()]) db.concept.key.delete(r.key);
  for (const r of [...db.category.iter()]) db.category.key.delete(r.key);

  const c = pack.content;
  for (const cat of c.categories) db.category.insert({ key: cat.key, title: cat.title, position: cat.position });
  for (const k of c.concepts) {
    db.concept.insert({
      key: k.key,
      category: k.category,
      title: k.title,
      language: k.language,
      gradeBand: k.gradeBand,
      dependsOn: JSON.stringify(k.dependsOn ?? []),
      summary: k.summary,
    });
  }
  const conceptOfSkill = new Map<string, string>();
  for (const s of c.skills) {
    conceptOfSkill.set(s.key, s.concept);
    db.skill.insert({
      key: s.key,
      concept: s.concept,
      position: s.position,
      title: s.title,
      kind: s.kind,
      steps: JSON.stringify(s.steps ?? []),
      keyStepIndex: s.keyStepIndex,
      commonMistake: s.commonMistake,
      tutorNote: s.tutorNote,
    });
  }
  for (const e of c.explanations) {
    db.explanation.insert({
      id: e.id,
      concept: e.concept,
      skill: e.skill,
      kind: e.kind,
      say: e.say,
      boardItems: JSON.stringify(e.boardItems ?? []),
    });
  }
  for (const t of c.tasks) {
    db.task.insert({
      key: t.key,
      skill: t.skill,
      concept: conceptOfSkill.get(t.skill) ?? '',
      type: t.type,
      difficulty: t.difficulty,
      show: t.show,
      say: t.say,
      answer: JSON.stringify(t.answer),
      steps: JSON.stringify(t.steps ?? []),
      wrongStepIndex: t.wrongStepIndex,
    });
  }

  const meta = db.libraryMeta.id.find(META_ID);
  const version = libraryVersion();
  if (meta) db.libraryMeta.id.update({ ...meta, packVersion: version });
  else db.libraryMeta.insert({ id: META_ID, packVersion: version });
}
