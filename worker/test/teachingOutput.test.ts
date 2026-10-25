import { expect, it } from 'vitest';
import { TOOL_NAMES, type LlmEvent } from '@tutor/shared';
import { teachingOutput } from '../src/teachingOutput';
import { done, FakeLlm, text, tool } from './fakes';

const opts = () => ({ messages: [], tools: [{ name: 'test', description: '', parameters: {} }], signal: new AbortController().signal });
async function collect(events: LlmEvent[], tools = opts().tools) {
  const result: LlmEvent[] = [];
  for await (const event of teachingOutput(new FakeLlm([events])).stream({ ...opts(), tools })) result.push(event);
  return result;
}

it('does not speak setup or repair commentary around a tool call', async () => {
  const call = tool(TOOL_NAMES.setTopic, { category: 'test' });
  expect(await collect([text('I will set the topic. '), call, text('The board failed, retrying.'), done])).toEqual([call, done]);
});

it('preserves a plain conversational reply and raw provider history', async () => {
  const end = { ...done, raw: ['provider history'] } as LlmEvent;
  expect(await collect([text('Which part '), text('seems confusing?'), end])).toEqual([text('Which part seems confusing?'), end]);
});

it('continues streaming the final tool-free fallback normally', async () => {
  const events = [text('Look at '), text('the two lengths.'), done];
  expect(await collect(events, [])).toEqual(events);
});

it('does not release buffered words after cancellation', async () => {
  const abort = new AbortController();
  const provider = { async *stream() { yield text('Unfinished planning'); abort.abort(); yield done; } };
  const output: LlmEvent[] = [];
  for await (const ev of teachingOutput(provider).stream({ ...opts(), signal: abort.signal })) output.push(ev);
  expect(output).toEqual([]);
});
