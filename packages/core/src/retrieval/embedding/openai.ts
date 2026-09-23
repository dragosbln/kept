// OpenAI implementation of EmbeddingClient over the Embeddings endpoint.
// Same transport boundary as the model client: every failure comes back as
// a transport_error with an OTel-style error type, never as a throw.

import OpenAI, { APIConnectionTimeoutError, APIError } from 'openai';
import type { ClientOptions } from 'openai';
import type { ErrorType } from '../../messages.js';
import type { EmbeddingClient } from './client.js';
import type { EmbedResponse, EmbeddingClientConfig } from './types.js';

export const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';

/** Same shape and purpose as OpenAITransportOptions on the model client. */
export type OpenAIEmbeddingTransportOptions = Pick<
  ClientOptions,
  'fetch' | 'baseURL' | 'timeout' | 'maxRetries'
>;

function malformed(message: string): EmbedResponse {
  return { type: 'transport_error', errorType: 'malformed_response', error: new Error(message) };
}

export class OpenAIEmbeddingClient implements EmbeddingClient {
  private readonly config: EmbeddingClientConfig;
  private readonly client: OpenAI;

  constructor(
    config: Omit<EmbeddingClientConfig, 'provider'>,
    apiKey: string,
    transport?: OpenAIEmbeddingTransportOptions,
  ) {
    this.config = { provider: 'openai', ...config };
    this.client = new OpenAI({ apiKey, ...transport });
  }

  async embed(texts: string[]): Promise<EmbedResponse> {
    if (texts.length === 0) {
      return { type: 'ok', vectors: [], usage: { inputTokens: 0 } };
    }
    try {
      const response = await this.client.embeddings.create({
        model: this.config.model,
        input: texts,
        // Sent explicitly so the vectors match the column width whatever the
        // model's native size is; the 3-series models accept a shorter width.
        dimensions: this.config.dimension,
        encoding_format: 'float',
      });
      const vectors = response.data
        .toSorted((a, b) => a.index - b.index)
        .map((item) => item.embedding);
      if (vectors.length !== texts.length) {
        return malformed(`expected ${texts.length} embeddings, got ${vectors.length}`);
      }
      const wrongWidth = vectors.find((vector) => vector.length !== this.config.dimension);
      if (wrongWidth) {
        return malformed(
          `expected ${this.config.dimension}-dimensional embeddings, got ${wrongWidth.length}`,
        );
      }
      return { type: 'ok', vectors, usage: { inputTokens: response.usage.prompt_tokens } };
    } catch (error) {
      let errorType: ErrorType;
      if (error instanceof APIConnectionTimeoutError) {
        errorType = 'timeout';
      } else if (error instanceof APIError) {
        errorType = error.status ? String(error.status) : '_OTHER';
      } else {
        errorType = '_OTHER';
      }
      return {
        type: 'transport_error',
        errorType,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  getConfig(): Readonly<EmbeddingClientConfig> {
    return { ...this.config };
  }
}
