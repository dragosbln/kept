import type { EmbedResponse, EmbeddingClientConfig } from './types.js';

/**
 * ModelClient's sibling (decision 2): an interface, a config naming the
 * provider and model, a typed result that never throws. Takes a list so
 * ingestion embeds the corpus in a handful of calls; a query passes a
 * one-element list.
 */
export interface EmbeddingClient {
  embed(texts: string[]): Promise<EmbedResponse>;
  getConfig(): Readonly<EmbeddingClientConfig>;
}
