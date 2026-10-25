import { useState } from 'react';
import { Tex } from '../Math';
import type { RendererProps } from '../types';

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

export function TextRenderer({ content }: RendererProps) {
  return <p className="text-lg leading-snug">{str(content.text)}</p>;
}

export function EquationRenderer({ content }: RendererProps) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Tex latex={str(content.latex)} display className="text-xl" />
      {content.caption ? <p className="text-sm text-muted-foreground">{str(content.caption)}</p> : null}
    </div>
  );
}

interface Step {
  show?: string;
  note?: string;
}

/** Steps appear one by one: one per sentence played after the item was revealed. */
export function WorkedStepsRenderer({ content, reveal }: RendererProps) {
  const steps: Step[] = Array.isArray(content.steps) ? (content.steps as Step[]) : [];
  const cap = typeof content.revealed === 'number' ? content.revealed : steps.length;
  const shown = Math.max(1, Math.min(cap, steps.length, reveal.progress));
  return (
    <div className="flex flex-col gap-2">
      {content.title ? <p className="font-medium">{str(content.title)}</p> : null}
      <ol className="flex flex-col gap-2">
        {steps.slice(0, shown).map((s, i) => (
          <li key={i} data-testid="worked-step" className="flex items-baseline gap-3 animate-[fadein_.3s_ease-out]">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
              {i + 1}
            </span>
            <div className="flex flex-col">
              <Tex latex={str(s.show)} />
              {s.note ? <span className="text-sm text-muted-foreground">{s.note}</span> : null}
            </div>
          </li>
        ))}
      </ol>
      {shown < Math.min(cap, steps.length) ? (
        <p className="text-xs text-muted-foreground">{Math.min(cap, steps.length) - shown} more…</p>
      ) : null}
    </div>
  );
}

const STATE_STYLE: Record<string, string> = {
  correct: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100',
  wrong: 'bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100',
  open: 'bg-secondary text-secondary-foreground',
};
const STATE_LABEL: Record<string, string> = { correct: 'Correct!', wrong: 'Not yet, try again', open: 'Your turn' };

export function GapTaskRenderer({ content, answer }: RendererProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = Array.isArray(content.choices) ? (content.choices as unknown[]).map(str) : [];
  const latex = str(content.latex);
  const filled = answer.state === 'correct' && answer.last ? latex.replace(/\\square/g, `\\boxed{${answer.last}}`) : latex;
  const send = async (a: string) => {
    if (!answer.submit || !a.trim()) return;
    setBusy(true);
    try {
      await answer.submit(a.trim());
      setValue('');
    } finally {
      setBusy(false);
    }
  };
  const state = answer.state || 'open';
  return (
    <div className="flex flex-col items-center gap-3">
      {content.prompt ? <p className="text-center">{str(content.prompt)}</p> : null}
      <Tex latex={filled} display className="text-xl" />
      {answer.submit && state !== 'correct' ? (
        choices.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-2">
            {choices.map(c => (
              <button
                key={c}
                data-testid="gap-choice"
                disabled={busy}
                onClick={() => send(c)}
                className="rounded-lg border bg-card px-4 py-2 text-lg font-medium hover:bg-accent disabled:opacity-50"
              >
                {c}
              </button>
            ))}
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={e => {
              e.preventDefault();
              void send(value);
            }}
          >
            <input
              data-testid="gap-input"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="?"
              className="w-24 rounded-lg border bg-background px-3 py-2 text-center text-lg"
            />
            <button
              data-testid="gap-submit"
              disabled={busy}
              className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
            >
              Check
            </button>
          </form>
        )
      ) : null}
      <span data-testid="gap-state" data-state={state} className={`rounded-full px-3 py-1 text-xs font-medium ${STATE_STYLE[state] ?? STATE_STYLE.open}`}>
        {STATE_LABEL[state] ?? state}
        {state === 'wrong' && answer.last ? ` (${answer.last})` : ''}
      </span>
    </div>
  );
}
