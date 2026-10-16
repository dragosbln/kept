import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalServiceConfig } from './config.js';
import type { EmbeddingClient } from './embedding/client.js';
import type { FaultToggle } from '../fault-toggles.js';
import type {
  KBRepository,
  RetrievalResult,
  RetrievalScope,
  RetrievalVerdict,
  RetrievedChunk,
} from './types.js';

export type RetrievalServiceOptions = {
  /**
   * The fault toggles this process runs under. Two concern the query:
   * `retrieval-scope-off` drops the store filter from both repository
   * calls, `stale-kb` drops the effective-date window from the binding
   * one. Absent means none.
   */
  faultToggles?: readonly FaultToggle[];
};

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
  private readonly faultToggles: readonly FaultToggle[];

  constructor(
    embeddingClient: EmbeddingClient,
    kbRepo: KBRepository,
    config: RetrievalServiceConfig = DEFAULT_RETRIEVAL_CONFIG,
    options: RetrievalServiceOptions = {},
  ) {
    this.embeddingClient = embeddingClient;
    this.kbRepo = kbRepo;
    this.serviceConfig = config;
    this.faultToggles = options.faultToggles ?? [];
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
    // HAND-WRITTEN (block 4): the two retrieval toggles, applied at the two
    // repository calls below. `retrieval-scope-off`: both calls carry
    // `{ storeFilterOff: true }`. `stale-kb`: the binding call is sent
    // without `asOf`, which is the same query the informational call
    // already runs, so expired and future binding sections rank. The
    // verdict stays truthful either way: it is derived from the tiers of
    // the chunks that cleared, not from which query returned them
    // (block 2, decision 6).
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
        this.kbRepo.retrieve(
          {
            storeId: scope.storeId,
            tiers: ['binding'],
            asOf: !this.faultToggles.includes('stale-kb') ? scope.asOf : undefined,
            topK: this.config.topKBinding,
            queryVector,
          },
          {
            storeFilterOff: this.faultToggles.includes('retrieval-scope-off'),
          },
        ),
        this.kbRepo.retrieve(
          {
            storeId: scope.storeId,
            tiers: ['informational'],
            topK: this.config.topKInformational,
            queryVector,
          },
          {
            storeFilterOff: this.faultToggles.includes('retrieval-scope-off'),
          },
        ),
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
