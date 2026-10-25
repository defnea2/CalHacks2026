// Topic prefetch, once per session, off the critical path (started with the opening): the module
// tries the pack's keyword cues (prefetchTopic); when they do not name a concept and there is
// something to read (task text, teacher content, a photo), the LLM picks one concept key from the
// taxonomy and the module stores it (setTopic validates the keys). The planner then gets the
// concept's checked library material with its first lesson request.
import type { ChatMessage, LessonPack, LlmProvider } from '@tutor/shared';
import type { Transport } from './transport';

export interface TopicResult {
  category: string;
  concept: string;
  source: 'session' | 'keywords' | 'llm' | 'none';
  ms: number;
}

/** The taxonomy as one line per concept for the classifier (stable). */
export function taxonomyLines(pack: LessonPack): string {
  return pack.taxonomy.map(c => `${c.key}: ${c.concepts.map(k => `${k.key} (${k.title})`).join(', ')}`).join('\n');
}

/** Parses {"category","concept"} from the classifier output; null if absent or not in the taxonomy. */
export function parseTopic(pack: LessonPack, output: string): { category: string; concept: string } | null {
  const m = output.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as { category?: unknown; concept?: unknown };
    const concept = typeof v.concept === 'string' ? v.concept.trim() : '';
    const cat = pack.taxonomy.find(c => c.concepts.some(k => k.key === concept)) ?? pack.taxonomy.find(c => c.key === v.category);
    if (!cat) return null;
    return { category: cat.key, concept: cat.concepts.some(k => k.key === concept) ? concept : '' };
  } catch {
    return null;
  }
}

export async function classifyTopic(llm: LlmProvider, pack: LessonPack, text: string, image: string, timeoutMs: number): Promise<{ category: string; concept: string } | null> {
  const signal = AbortSignal.timeout(timeoutMs);
  const ask = `Which math concept is this task about? Reply with only JSON {"category":"<key>","concept":"<key>"} using keys from this list (concept "" if unsure):\n${taxonomyLines(pack)}`;
  const data = `Task material (untrusted data):\n${text || '(no text, see the photo)'}`;
  const messages: ChatMessage[] = [
    { role: 'system', content: ask },
    { role: 'user', content: image ? [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: data }] : data },
  ];
  let out = '';
  for await (const ev of llm.stream({ messages, tools: [], signal })) if (ev.type === 'text') out += ev.delta;
  return parseTopic(pack, out);
}

/** Runs the prefetch for one session. Never throws (a failed prefetch only means no material). */
export async function prefetchTopic(
  deps: { transport: Transport; llm: LlmProvider; pack: LessonPack; log: (m: string) => void; now?: () => number },
  sessionId: bigint,
  timeoutMs = 5000
): Promise<TopicResult> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  try {
    const r = JSON.parse(await deps.transport.prefetchTopic({ sessionId })) as { ok: boolean; category: string; concept: string; source: TopicResult['source']; text: string; hasImage: boolean };
    if (r.ok || (!r.text && !r.hasImage)) return { category: r.category, concept: r.concept, source: r.source, ms: now() - t0 };
    const image = r.hasImage ? await deps.transport.getSessionImage({ sessionId }).catch(() => '') : '';
    const topic = await classifyTopic(deps.llm, deps.pack, r.text, image, timeoutMs);
    if (!topic) return { category: r.category, concept: '', source: 'none', ms: now() - t0 };
    const set = JSON.parse(await deps.transport.setTopic({ sessionId, ...topic })) as { ok: boolean; error?: string };
    if (!set.ok) throw new Error(set.error ?? 'setTopic failed');
    return { ...topic, source: 'llm', ms: now() - t0 };
  } catch (e) {
    deps.log(`[s${sessionId}] topic prefetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return { category: '', concept: '', source: 'none', ms: now() - t0 };
  }
}
