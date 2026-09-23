// The model-mismatch invariant of decision 2, enforced at the two points a
// store's chunks and an embedding client meet: boot (the read side) and
// ingest (the write side). One query, `SELECT DISTINCT embedding_model`,
// three outcomes; the service then runs under the precondition that the
// check passed and never re-checks per call.

import type { EmbeddingClient } from './embedding/client.js';
import type { KBRepository } from './types.js';

export type EmbeddingModelCheckCode =
  | 'no_corpus'
  | 'multiple_embedding_models_in_store'
  | 'embedding_model_mismatch'
  | 'embedding_dimension_mismatch';

export class EmbeddingModelCheckError extends Error {
  constructor(
    readonly code: EmbeddingModelCheckCode,
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingModelCheckError';
  }
}

export type EmbeddingModelCheckOptions = {
  /** Ingest allows an empty store (the first load); boot does not (a store with no corpus answers nothing). */
  allowEmpty: boolean;
};

export function checkEmbeddingModelsAgree(
  storedModels: readonly string[],
  clientModel: string,
  { allowEmpty }: EmbeddingModelCheckOptions,
): void {
  if (storedModels.length === 0) {
    if (allowEmpty) return;
    throw new EmbeddingModelCheckError(
      'no_corpus',
      'no policy chunks ingested for this store; run `pnpm kb:ingest`',
    );
  }
  if (storedModels.length > 1) {
    throw new EmbeddingModelCheckError(
      'multiple_embedding_models_in_store',
      `store holds chunks from ${storedModels.length} embedding models (${storedModels.join(', ')}); re-ingest under one`,
    );
  }
  const [stored] = storedModels;
  if (stored !== clientModel) {
    throw new EmbeddingModelCheckError(
      'embedding_model_mismatch',
      `store was embedded with ${stored}, the client is ${clientModel}; a query would rank nothing correctly`,
    );
  }
}

/** The check over a live repository and client. `expectedDimension` is the vector column's width when the caller knows it. */
export async function assertStoreEmbeddingModel(
  kbRepo: KBRepository,
  embeddingClient: EmbeddingClient,
  storeId: string,
  options: EmbeddingModelCheckOptions & { expectedDimension?: number },
): Promise<void> {
  const config = embeddingClient.getConfig();
  if (options.expectedDimension !== undefined && config.dimension !== options.expectedDimension) {
    throw new EmbeddingModelCheckError(
      'embedding_dimension_mismatch',
      `the embedding client produces ${config.dimension}-wide vectors, the store holds ${options.expectedDimension}-wide ones`,
    );
  }
  const stored = await kbRepo.getEmbeddingModelsForStore(storeId);
  checkEmbeddingModelsAgree(stored, config.model, { allowEmpty: options.allowEmpty });
}
