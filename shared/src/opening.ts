// Authored opening lines (worker ReplyRun/LessonRun prelude and the module's Cloudflare dispatch).

/** Authored opening lines: one per row; rows with {{task}} are skipped when there is no task. */
export function openingLines(script: string, taskText: string): string[] {
  const task = taskText.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
  const short = task.split(' ').slice(0, 30).join(' ');
  return script
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && (short || !l.includes('{{task}}')))
    .map(l => l.replace('{{task}}', short));
}
