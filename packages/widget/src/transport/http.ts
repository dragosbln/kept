// HTTP transport against the agent service's POST /chat route.
//
// No automatic retries anywhere in this file, by design: a turn is not an
// idempotent operation from the transport's point of view, so a retry is a
// customer decision surfaced by the UI, not a transport policy. The request
// carries clientMessageId so the server can make even that retry safe once
// it chooses to dedupe.

import { parseSendMessageResponse, parseWireErrorCode } from '../protocol/types.js';
import type { SendMessageRequest } from '../protocol/types.js';
import type { KeptTransport, SendResult } from './types.js';

export const MESSAGES_PATH = 'chat';

/**
 * Whole-turn budget. A turn can run several model rounds with tool calls
 * in between (each tool capped server-side), so this is deliberately
 * generous; merchants tune it via config.requestTimeoutMs.
 */
export const DEFAULT_TIMEOUT_MS = 60_000;

export type HttpTransportOptions = {
  /** Agent service base URL, e.g. "http://localhost:3100". */
  endpoint: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

export class HttpTransport implements KeptTransport {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpTransportOptions) {
    // A malformed endpoint throws here, at configuration time, not at the
    // customer's first message.
    this.url = new URL(MESSAGES_PATH, withTrailingSlash(options.endpoint)).toString();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async send(request: SendMessageRequest): Promise<SendResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.exchange(request, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private async exchange(request: SendMessageRequest, signal: AbortSignal): Promise<SendResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
    } catch {
      return signal.aborted
        ? { delivered: false, failure: { kind: 'timeout', afterMs: this.timeoutMs } }
        : { delivered: false, failure: { kind: 'network' } };
    }

    if (!response.ok) {
      const code = parseWireErrorCode(await safeJson(response));
      return { delivered: false, failure: { kind: 'http', status: response.status, code } };
    }

    const body = await safeJson(response);
    const parsed = body === undefined ? null : parseSendMessageResponse(body);
    if (!parsed) {
      // The timeout can also fire mid-body-read; that is still a timeout,
      // not a protocol violation by the server.
      return signal.aborted
        ? { delivered: false, failure: { kind: 'timeout', afterMs: this.timeoutMs } }
        : { delivered: false, failure: { kind: 'protocol', detail: 'unparseable response body' } };
    }
    return { delivered: true, conversationId: parsed.conversationId, outcome: parsed.outcome };
  }
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Body parse that never throws. Returns undefined (never a JSON value) on
 * failure so callers can tell "no body" from a parsed null.
 */
async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
