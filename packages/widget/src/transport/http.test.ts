// Pins the transport's failure taxonomy — the raw material for the
// failed-vs-unknown delivery decision — and the exact request shape the
// handler will receive, including the absence of conversationId on a first
// turn (absent, not null, not undefined-valued).

import { describe, expect, it } from 'vitest';
import type { SendMessageRequest } from '../protocol/types.js';
import { HttpTransport } from './http.js';

type RecordedCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchStub(respond: (url: string, init: RequestInit) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call.url, call.init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const request: SendMessageRequest = {
  message: 'Where is my order?',
  clientMessageId: 'cmid-1',
};

const replyBody = {
  conversationId: 'c-1',
  outcome: { type: 'reply', message: 'On its way.' },
};

describe('HttpTransport', () => {
  it('POSTs JSON to {endpoint}/chat, with and without a trailing slash', async () => {
    await Promise.all(
      ['http://agent.test', 'http://agent.test/'].map(async (endpoint) => {
        const { fetchImpl, calls } = fetchStub(() => jsonResponse(replyBody));
        const transport = new HttpTransport({ endpoint, fetchImpl });
        await transport.send(request);
        expect(calls[0]?.url).toBe('http://agent.test/chat');
        expect(calls[0]?.init.method).toBe('POST');
        expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' });
      }),
    );
  });

  it('omits conversationId from the body on a first turn — absent, not null', async () => {
    const { fetchImpl, calls } = fetchStub(() => jsonResponse(replyBody));
    const transport = new HttpTransport({ endpoint: 'http://agent.test', fetchImpl });
    await transport.send(request);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toEqual({ message: 'Where is my order?', clientMessageId: 'cmid-1' });
    expect('conversationId' in body).toBe(false);
  });

  it('sends conversationId on later turns', async () => {
    const { fetchImpl, calls } = fetchStub(() => jsonResponse(replyBody));
    const transport = new HttpTransport({ endpoint: 'http://agent.test', fetchImpl });
    await transport.send({ ...request, conversationId: 'c-1' });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['conversationId']).toBe('c-1');
  });

  it('returns the outcome on a valid 200', async () => {
    const { fetchImpl } = fetchStub(() => jsonResponse(replyBody));
    const transport = new HttpTransport({ endpoint: 'http://agent.test', fetchImpl });
    const result = await transport.send(request);
    expect(result).toEqual({
      delivered: true,
      conversationId: 'c-1',
      outcome: { type: 'reply', message: 'On its way.' },
    });
  });

  it('classifies a 200 with an off-contract body as a protocol failure', async () => {
    const { fetchImpl } = fetchStub(() => jsonResponse({ unexpected: true }));
    const transport = new HttpTransport({ endpoint: 'http://agent.test', fetchImpl });
    const result = await transport.send(request);
    expect(result).toEqual({
      delivered: false,
      failure: { kind: 'protocol', detail: 'unparseable response body' },
    });
  });

  it('classifies a 200 with a non-JSON body as a protocol failure', async () => {
    const { fetchImpl } = fetchStub(() => new Response('<html>gateway page</html>'));
    const transport = new HttpTransport({ endpoint: 'http://agent.test', fetchImpl });
    const result = await transport.send(request);
    expect(result.delivered).toBe(false);
    if (!result.delivered) expect(result.failure.kind).toBe('protocol');
  });

  it('surfaces the error code from a 4xx envelope', async () => {
    const { fetchImpl } = fetchStub(() =>
      jsonResponse({ error: { code: 'conversation_locked' } }, 409),
    );
    const transport = new HttpTransport({ endpoint: 'http://agent.test', fetchImpl });
    const result = await transport.send(request);
    expect(result).toEqual({
      delivered: false,
      failure: { kind: 'http', status: 409, code: 'conversation_locked' },
    });
  });

  it('classifies a 5xx without an envelope as http with a null code', async () => {
    const { fetchImpl } = fetchStub(() => new Response('boom', { status: 500 }));
    const transport = new HttpTransport({ endpoint: 'http://agent.test', fetchImpl });
    const result = await transport.send(request);
    expect(result).toEqual({
      delivered: false,
      failure: { kind: 'http', status: 500, code: null },
    });
  });

  it('classifies a rejected fetch as a network failure', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const transport = new HttpTransport({ endpoint: 'http://agent.test', fetchImpl });
    const result = await transport.send(request);
    expect(result).toEqual({ delivered: false, failure: { kind: 'network' } });
  });

  it('aborts a hung request and classifies it as a timeout', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      })) as typeof fetch;
    const transport = new HttpTransport({
      endpoint: 'http://agent.test',
      timeoutMs: 20,
      fetchImpl,
    });
    const result = await transport.send(request);
    expect(result).toEqual({
      delivered: false,
      failure: { kind: 'timeout', afterMs: 20 },
    });
  });

  it('rejects a malformed endpoint at construction, not at first send', () => {
    expect(() => new HttpTransport({ endpoint: 'not a url' })).toThrow();
  });
});
