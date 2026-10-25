import katex from 'katex';
import { useMemo } from 'react';

/** KaTeX, never throws: bad LaTeX renders as red source text. */
export function Tex({ latex, display = false, className }: { latex: string; display?: boolean; className?: string }) {
  const html = useMemo(
    () => katex.renderToString(latex ?? '', { throwOnError: false, displayMode: display, strict: 'ignore', output: 'html' }),
    [latex, display]
  );
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
