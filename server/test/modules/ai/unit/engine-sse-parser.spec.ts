// server/test/modules/ai/unit/engine-sse-parser.spec.ts

import { parseEngineSSE } from 'src/modules/ai/services/engine-sse-parser';

async function* fromChunks(chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

async function collect(source: AsyncIterable<string>) {
  const events = [];
  for await (const event of parseEngineSSE(source)) {
    events.push(event);
  }
  return events;
}

describe('parseEngineSSE', () => {
  it('parses a single event delivered in one chunk', async () => {
    const events = await collect(fromChunks(['event: chunk\ndata: {"content":"hi"}\n\n']));

    expect(events).toEqual([{ type: 'chunk', data: { content: 'hi' } }]);
  });

  it('parses multiple events delivered in one chunk', async () => {
    const events = await collect(
      fromChunks(['event: chunk\ndata: {"content":"a"}\n\nevent: chunk\ndata: {"content":"b"}\n\n'])
    );

    expect(events).toEqual([
      { type: 'chunk', data: { content: 'a' } },
      { type: 'chunk', data: { content: 'b' } },
    ]);
  });

  it('reassembles an event split mid-line across chunks', async () => {
    const events = await collect(fromChunks(['event: chu', 'nk\ndata: {"content":"hi"}\n\n']));

    expect(events).toEqual([{ type: 'chunk', data: { content: 'hi' } }]);
  });

  it('reassembles an event split between data and the terminating blank line', async () => {
    const events = await collect(fromChunks(['event: chunk\ndata: {"content":"hi"}\n', '\n']));

    expect(events).toEqual([{ type: 'chunk', data: { content: 'hi' } }]);
  });

  it('skips :comment keepalive lines without yielding a bogus event', async () => {
    const events = await collect(fromChunks([':heartbeat\n\nevent: chunk\ndata: {"content":"hi"}\n\n']));

    expect(events).toEqual([{ type: 'chunk', data: { content: 'hi' } }]);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(fromChunks(['event: chunk\r\ndata: {"content":"hi"}\r\n\r\n']));

    expect(events).toEqual([{ type: 'chunk', data: { content: 'hi' } }]);
  });

  it('joins multi-line data fields with newlines before parsing', async () => {
    // Not JSON, so it comes back as the raw joined string rather than throwing.
    const events = await collect(fromChunks(['event: note\ndata: line one\ndata: line two\n\n']));

    expect(events).toEqual([{ type: 'note', data: 'line one\nline two' }]);
  });

  it('discards a trailing partial event when the stream ends with no blank line', async () => {
    const events = await collect(
      fromChunks(['event: chunk\ndata: {"content":"hi"}\n\nevent: chunk\ndata: {"content"'])
    );

    expect(events).toEqual([{ type: 'chunk', data: { content: 'hi' } }]);
  });

  it('parses an event with an empty data payload', async () => {
    const events = await collect(fromChunks(['event: engine-done\ndata: {}\n\n']));

    expect(events).toEqual([{ type: 'engine-done', data: {} }]);
  });
});
