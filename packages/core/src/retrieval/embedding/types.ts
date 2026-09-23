import type { ErrorType } from '../../messages.js';
import type { EmbeddingVector } from '../types.js';

export type EmbeddingProvider = 'openai';

export type EmbeddingClientConfig = {
  provider: EmbeddingProvider;
  model: string;
  dimension: number;
};

/**
 * Same boundary as CallModelResponse: the client never throws, it returns
 * a typed outcome, so the service's error mapping stays a switch. `ok`
 * carries one vector per input, in input order.
 */
export type EmbedResponse =
  | { type: 'ok'; vectors: EmbeddingVector[]; usage: { inputTokens: number } }
  | { type: 'transport_error'; errorType: ErrorType; error: Error };
