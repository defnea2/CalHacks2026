// @vitest-environment node
import { expect, it } from "vitest";
import { readEventStream } from "./eventStream";

it("decodes fragmented UTF-8, comments, CRLF and multiline SSE data", async () => {
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: beat\r\ndata: {"word":\r\ndata: "café"}\r\n\r\n');
  const stream = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const events = [];
  for await (const event of readEventStream(stream)) events.push(event);
  expect(events).toEqual([{ word: "café" }]);
});
it("rejects incomplete final events", async () => {
  const body = new Response('data: {"partial":true}').body!;
  await expect(async () => { for await (const _event of readEventStream(body)) { /* consume */ } }).rejects.toThrow("Incomplete");
});
