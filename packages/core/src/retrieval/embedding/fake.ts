import type { ErrorType } from '../../messages.js';
import type { EmbeddingVector } from '../types.js';
import type { EmbeddingClient } from './client.js';
import type { EmbedResponse, EmbeddingClientConfig } from './types.js';

export type FakeEmbeddingOptions = {
  dimension?: number;
  model?: string;
  /** When set, every call fails with this error type. */
  fail?: ErrorType;
};

function fnv1a(word: string): number {
  let hash = 0x811c9dc5;
  for (const char of word) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Each word lands in one dimension; the vector is unit length. */
export function bagOfWordsVector(text: string, dimension: number): EmbeddingVector {
  const vector = Array.from({ length: dimension }, () => 0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const word of words) {
    const bucket = fnv1a(word) % dimension;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  const norm = Math.hypot(...vector);
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((value) => value / norm);
}

/**
 * Deterministic bag-of-words embeddings for tests: cosine distance is 0 for
 * the same words, 1 for disjoint words, in between for overlap. No network,
 * no randomness, any dimension the schema asks for. Records every call.
 */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly calls: string[][] = [];
  private readonly config: EmbeddingClientConfig;
  private readonly fail: ErrorType | undefined;

  constructor(options: FakeEmbeddingOptions = {}) {
    this.config = {
      provider: 'openai',
      model: options.model ?? 'fake-bag-of-words',
      dimension: options.dimension ?? 64,
    };
    this.fail = options.fail;
  }

  async embed(texts: string[]): Promise<EmbedResponse> {
    this.calls.push([...texts]);
    if (this.fail !== undefined) {
      return {
        type: 'transport_error',
        errorType: this.fail,
        error: new Error(`fake embedding failure: ${this.fail}`),
      };
    }
    return {
      type: 'ok',
      vectors: texts.map((text) => bagOfWordsVector(text, this.config.dimension)),
      usage: { inputTokens: texts.reduce((sum, text) => sum + text.split(/\s+/).length, 0) },
    };
  }

  getConfig(): Readonly<EmbeddingClientConfig> {
    return { ...this.config };
  }
}
