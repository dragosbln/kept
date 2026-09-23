export type RetrievalServiceConfig = {
  /** Separate budgets per tier, so binding chunks are never crowded out by help articles (decision 6). */
  topKBinding: number;
  topKInformational: number;
  /**
   * Cosine-distance threshold: a ranked chunk further than this is marked
   * dropped (decision 3). Calibrated, not guessed (decision 5): the default
   * below is a placeholder until the calibration run on the fixture corpus
   * replaces it; see scripts/kb-calibrate.ts.
   */
  maxDistance: number;
};

export const DEFAULT_RETRIEVAL_CONFIG: Readonly<RetrievalServiceConfig> = {
  topKBinding: 5,
  topKInformational: 3,
  // calibrated using the kb-calibrate script
  maxDistance: 0.665,
};
