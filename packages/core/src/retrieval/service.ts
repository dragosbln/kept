import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalServiceConfig } from './config.js';
import type { EmbeddingClient } from './embedding/client.js';
import type {
  KBRepository,
  RetrievalResult,
  RetrievalScope,
  RetrievalVerdict,
  RetrievedChunk,
} from './types.js';

export type RetrievalErrorKind = 'embedding_failed' | 'repository_failed';

/**
 * A retrieval that produced no result at all, as opposed to a `no_match`
 * verdict, which is a result. The tool maps it to `failed`: nothing was
 * written, so the model may retry once (the tool pin in the sketch).
 */
export class RetrievalError extends Error {
  constructor(
    readonly kind: RetrievalErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RetrievalError';
  }
}

/**
 * The query side of the retrieval core. Stateless between calls: the store
 * and the clock arrive with each call (decision 4), the host has already
 * verified the store's embedding model against the client (decision 2, see
 * boot.ts), so nothing here re-checks it.
 */
export class RetrievalService {
  private readonly embeddingClient: EmbeddingClient;
  private readonly kbRepo: KBRepository;
  private readonly serviceConfig: RetrievalServiceConfig;

  constructor(
    embeddingClient: EmbeddingClient,
    kbRepo: KBRepository,
    config: RetrievalServiceConfig = DEFAULT_RETRIEVAL_CONFIG,
  ) {
    this.embeddingClient = embeddingClient;
    this.kbRepo = kbRepo;
    this.serviceConfig = config;
  }

  /** Stamped on the retrieval span by the tool, so a trace says which thresholds ranked it. */
  get config(): Readonly<RetrievalServiceConfig> {
    return this.serviceConfig;
  }

  private computeVerdict(survivingChunks: RetrievedChunk[]): RetrievalVerdict {
    if (survivingChunks.some((chunk) => chunk.tier === 'binding')) {
      return 'grounded';
    }
    if (survivingChunks.length) {
      return 'informational_only';
    }
    return 'no_match';
  }

  /**
   * HAND-WRITTEN (block 2): the pipeline of decision 3 and the verdict of
   * decision 6.
   *
   * 1. Embed the question, a one-element batch. A transport error becomes
   *    RetrievalError('embedding_failed'); a repository throw becomes
   *    RetrievalError('repository_failed').
   * 2. Two repository queries: binding with `asOf` and topKBinding;
   *    informational without `asOf` and topKInformational.
   * 3. Threshold in code: distance > maxDistance marks a chunk `dropped`,
   *    never removes it.
   * 4. Verdict from the chunks that cleared.
   * 5. Order: binding first, then informational; by distance within a tier.
   *
   * `this.embeddingClient`, `this.kbRepo` and `this.serviceConfig` are the
   * three collaborators; nothing else is needed.
   */
  async retrieve(question: string, scope: RetrievalScope): Promise<RetrievalResult> {
    const embedResponse = await this.embeddingClient.embed([question]);
    if (embedResponse.type === 'transport_error') {
      throw new RetrievalError(
        'embedding_failed',
        `Embedding question failed: ${embedResponse.errorType}`,
        { cause: embedResponse.error },
      );
    }

    const queryVector = embedResponse.vectors[0];

    if (!queryVector) {
      throw new RetrievalError(
        'embedding_failed',
        `Malformed response. Expected array with 1 element, but got empty array`,
      );
    }

    try {
      const [bindingChunks, informationalChunks] = await Promise.all([
        this.kbRepo.retrieve({
          storeId: scope.storeId,
          tiers: ['binding'],
          asOf: scope.asOf,
          topK: this.config.topKBinding,
          queryVector,
        }),
        this.kbRepo.retrieve({
          storeId: scope.storeId,
          tiers: ['informational'],
          topK: this.config.topKInformational,
          queryVector,
        }),
      ]);

      const allChunks: RetrievedChunk[] = [
        ...bindingChunks.toSorted((a, b) => a.distance - b.distance),
        ...informationalChunks.toSorted((a, b) => a.distance - b.distance),
      ].map((chunk) => ({
        id: chunk.id,
        docId: chunk.docId,
        docTitle: chunk.docTitle,
        sectionRef: chunk.sectionRef,
        tier: chunk.tier,
        version: chunk.version,
        text: chunk.text,
        effectiveFrom: chunk.effectiveFrom,
        effectiveTo: chunk.effectiveTo,
        distance: chunk.distance,
        dropped: chunk.distance > this.config.maxDistance,
      }));

      return {
        verdict: this.computeVerdict(allChunks.filter((chunk) => !chunk.dropped)),
        chunks: allChunks,
      };
    } catch (error) {
      throw new RetrievalError('repository_failed', 'Error retrieving chunks', { cause: error });
    }
  }
}
