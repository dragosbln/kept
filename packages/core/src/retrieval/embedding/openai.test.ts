// The OpenAI embedding client against a stubbed fetch: order restoration by
// index, the request shape, and the never-throws boundary.

import { describe, expect, it, vi } from 'vitest';
import { OpenAIEmbeddingClient, type OpenAIEmbeddingTransportOptions } from './openai.js';

type Fetch = NonNullable<OpenAIEmbeddingTransportOptions['fetch']>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientOver(fetch: Fetch): OpenAIEmbeddingClient {
  return new OpenAIEmbeddingClient({ model: 'text-embedding-3-small', dimension: 3 }, 'sk-test', {
    fetch,
    maxRetries: 0,
  });
}

const embeddingsBody = (
  data: { index: number; embedding: number[] }[],
  promptTokens = 7,
): Record<string, unknown> => ({
  object: 'list',
  data: data.map((item) => ({ object: 'embedding', ...item })),
  model: 'text-embedding-3-small',
  usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
});

describe('OpenAIEmbeddingClient', () => {
  it('returns one vector per input in input order, whatever order the API used', async () => {
    const fetch = vi.fn<Fetch>(async () =>
      jsonResponse(
        embeddingsBody([
          { index: 1, embedding: [0, 1, 0] },
          { index: 0, embedding: [1, 0, 0] },
        ]),
      ),
    );
    const response = await clientOver(fetch).embed(['first', 'second']);
    expect(response).toEqual({
      type: 'ok',
      vectors: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      usage: { inputTokens: 7 },
    });
  });

  it('sends the model, the inputs and the dimension', async () => {
    const fetch = vi.fn<Fetch>(async () =>
      jsonResponse(embeddingsBody([{ index: 0, embedding: [1, 0, 0] }])),
    );
    await clientOver(fetch).embed(['only']);
    const [, init] = fetch.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'text-embedding-3-small',
      input: ['only'],
      dimensions: 3,
      encoding_format: 'float',
    });
  });

  it('embeds nothing without a request', async () => {
    const fetch = vi.fn<Fetch>();
    await expect(clientOver(fetch).embed([])).resolves.toEqual({
      type: 'ok',
      vectors: [],
      usage: { inputTokens: 0 },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('classifies an API error by status instead of throwing', async () => {
    const fetch = vi.fn<Fetch>(async () =>
      jsonResponse({ error: { message: 'boom', type: 'server_error' } }, 500),
    );
    await expect(clientOver(fetch).embed(['x'])).resolves.toMatchObject({
      type: 'transport_error',
      errorType: '500',
    });
  });

  it('classifies a response with the wrong number or width of vectors as malformed', async () => {
    const short = vi.fn<Fetch>(async () =>
      jsonResponse(embeddingsBody([{ index: 0, embedding: [1, 0, 0] }])),
    );
    await expect(clientOver(short).embed(['a', 'b'])).resolves.toMatchObject({
      type: 'transport_error',
      errorType: 'malformed_response',
    });
    const narrow = vi.fn<Fetch>(async () =>
      jsonResponse(embeddingsBody([{ index: 0, embedding: [1, 0] }])),
    );
    await expect(clientOver(narrow).embed(['a'])).resolves.toMatchObject({
      type: 'transport_error',
      errorType: 'malformed_response',
    });
  });

  it('reports its config without exposing the live object', () => {
    const client = clientOver(vi.fn<Fetch>());
    const config = client.getConfig();
    expect(config).toEqual({ provider: 'openai', model: 'text-embedding-3-small', dimension: 3 });
    expect(client.getConfig()).not.toBe(config);
  });
});
