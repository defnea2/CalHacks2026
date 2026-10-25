// Prompt layout (spec): 1. system prompt from the pack, 2. context from buildContext,
// 3. the task photo on the first call, 4. recent turns, 5. the current turn (or the opening
// instruction), 6. the current phase block (pack.prompts.phase) as a system message.
// The system prompt never changes during a session (prompt cache; replayed thinking blocks
// are rejected after any change to it), so phase instructions live only in the phase block.
import { describeBoardKinds, describePhases, describeTaxonomy, renderTemplate, type ChatMessage, type LessonPack, type ToolSpec } from '@tutor/shared';
import type { TurnRow } from './transport';

export function buildSystemPrompt(pack: LessonPack, tools: ToolSpec[]): string {
  return renderTemplate(pack.prompts.system, {
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
  /** Current phase block (renderPhaseBlock), appended after the current turn; '' = none. */
  phaseBlock?: string;
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
    if (p.phaseBlock) msgs.push({ role: 'system', content: p.phaseBlock });
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
  // A lesson button of the team UI (turn.intent) travels with the turn text.
  const intent = p.turns.find(t => t.idx === cur.idx && t.role === 'student')?.intent;
  msgs.push({ role: 'user', content: intent ? `${cur.text}

[The student pressed the lesson button "${intent}".]` : cur.text });
  if (p.phaseBlock) msgs.push({ role: 'system', content: p.phaseBlock });
  return msgs;
}
