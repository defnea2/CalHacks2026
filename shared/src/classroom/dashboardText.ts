// Teacher-dashboard prose (class summary, cluster names/descriptions): learner ids belong only in
// the structured `learnerIds`. The prompt passes names; this post-check removes ids the LLM still
// writes into the text ("Jonas (16)", "Jonas (id 16)", "Jonas [#16]", "student 16").

export interface NamedLearner {
  id: string;
  name: string;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name.trim();

/** Removes `(digits)`-style id tags after student names and replaces bare "student <id>" with the name. */
export function stripLearnerIds(text: string, learners: NamedLearner[]): string {
  if (!text) return text;
  let out = text;
  const names = new Set<string>();
  for (const l of learners) {
    if (l.name.trim()) names.add(l.name.trim());
    if (firstName(l.name)) names.add(firstName(l.name));
  }
  // Longest first so "Jonas Weber (16)" is handled before "Jonas".
  const alts = [...names].sort((a, b) => b.length - a.length).map(esc);
  if (alts.length) {
    const tag = new RegExp(`(^|[^\\p{L}])(${alts.join('|')})\\s*[([]\\s*(?:(?:learner\\s*)?id\\s*[:=]?\\s*)?#?\\d+\\s*[)\\]]`, 'giu');
    out = out.replace(tag, '$1$2');
    const hash = new RegExp(`(^|[^\\p{L}])(${alts.join('|')})\\s*#\\d+\\b`, 'giu');
    out = out.replace(hash, '$1$2');
  }
  const byId = new Map(learners.map(l => [l.id, firstName(l.name)]));
  out = out.replace(/\b(?:student|learner)\s*(?:id\s*)?#?(\d+)\b/gi, (m, id: string) => byId.get(id) ?? m);
  return out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1');
}
