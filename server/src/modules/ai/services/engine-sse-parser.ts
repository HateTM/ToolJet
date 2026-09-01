export type EngineSSEEvent = {
  type: string;
  data: unknown;
};

/**
 * Pure SSE wire parser for the Generation engine's stream (ADR-0027): takes
 * whatever chunking the transport happens to deliver (a fetch body reader
 * yields arbitrary byte boundaries, not event boundaries) and yields whole
 * `{ type, data }` events.
 *
 * Deliberately dumb about the *meaning* of event types — `chunk` /
 * `engine-done` / `engine-error` are the caller's (GenerationEngineClient's)
 * concern, not this parser's. This module only knows the wire format:
 *
 *   event: <type>\n
 *   data: <json, possibly multi-line>\n
 *   \n
 *
 * plus the two things that trip a naive `split('\n\n')`:
 *  - `:comment\n\n` keepalive/heartbeat lines (the engine's own `initSSE`-style
 *    preamble, and any proxy in between) — skipped, not yielded.
 *  - an event split across chunk boundaries, including mid-line and between
 *    `data:` and the terminating blank line — buffered until a full event is
 *    available.
 *
 * A trailing partial event when the stream ends (no final blank line) is
 * discarded rather than yielded half-formed; the caller treats "stream ended
 * with no engine-done" as an error regardless (see GenerationEngineClient).
 */
export async function* parseEngineSSE(source: AsyncIterable<string | Buffer>): AsyncGenerator<EngineSSEEvent> {
  let buffer = '';

  for await (const piece of source) {
    buffer += typeof piece === 'string' ? piece : piece.toString('utf8');
    buffer = buffer.replace(/\r\n/g, '\n');

    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const event = parseOneEvent(rawEvent);
      if (event) {
        yield event;
      }
    }
  }
}

function parseOneEvent(rawEvent: string): EngineSSEEvent | null {
  let type: string | null = null;
  const dataLines: string[] = [];

  for (const line of rawEvent.split('\n')) {
    if (line.startsWith(':')) {
      // Comment/keepalive line — not part of any event, ignored.
      continue;
    }
    if (line.startsWith('event:')) {
      type = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (!type) {
    // A pure `:heartbeat` block (no `event:` line) — not a real event.
    return null;
  }

  const rawData = dataLines.join('\n');
  let data: unknown = undefined;
  if (rawData.length) {
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
  }

  return { type, data };
}
