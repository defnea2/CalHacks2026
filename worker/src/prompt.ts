// Prompt layout (spec): 1. system prompt from the pack, 2. context from buildContext,
// 3. recent turns, 4. the task photo on the first call.
import {
  describeBoardKinds,
  describePhases,
  describeTaxonomy,
  getPhase,
  phaseInstructions,
  renderTemplate,
  type ChatMessage,
  type LessonPack,
  type ToolSpec,
} from '@tutor/shared';
import type { TurnRow } from './transport';

/** System prompt for one LLM call. `phase` is the session's CURRENT phase: only its
 *  instructions are in the prompt, so a phase change swaps the whole block. */
export function buildSystemPrompt(pack: LessonPack, tools: ToolSpec[], phase: string = pack.initialPhase): string {
  const p = getPhase(pack, phase);
  return renderTemplate(pack.prompts.system, {
    phase: p ? `${p.id} (${p.label})` : phase,
    phaseInstructions: phaseInstructions(pack, phase),
    phases: describePhases(pack),
    concepts: describeTaxonomy(pack),
    board: describeBoardKinds(pack),
    tools: tools.map(t => `- ${t.name}: ${t.description}`).join('\n'),
  });
}

export interface PromptInput {
  system: string;
  context: string;
  /** Earlier turns of the session, any order; only those before `current.idx` are used. */
  turns: TurnRow[];
  /** The student turn being answered (text = the transcript this reply is based on), or the
   *  opening (the tutor speaks first: no earlier turns, the pack's opening instruction instead). */
  current: { idx: number; text: string } | { opening: string };
  recentTurns: number;
  /** Data URL of the task photo, or ''. */
  image: string;
}

export function buildMessages(p: PromptInput): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: 'system', content: p.system }];
  if (p.context.trim()) msgs.push({ role: 'system', content: p.context });
  if (p.image) {
    msgs.push({
      role: 'user',
      content: [
        { type: 'text', text: 'Photo of the task the student is working on:' },
        { type: 'image_url', image_url: { url: p.image } },
      ],
    });
  }
  const cur = p.current;
  if ('opening' in cur) {
    msgs.push({ role: 'user', content: cur.opening });
    return msgs;
  }
  const earlier = p.turns
    .filter(t => t.idx < cur.idx && t.text.trim())
    .sort((a, b) => a.idx - b.idx)
    .slice(-Math.max(0, p.recentTurns - 1));
  for (const t of earlier) {
    if (t.role === 'tutor') msgs.push({ role: 'assistant', content: t.interrupted ? `${t.text} [the student interrupted here]` : t.text });
    else msgs.push({ role: 'user', content: t.text });
  }
  msgs.push({ role: 'user', content: cur.text });
  return msgs;
}
