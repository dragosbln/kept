// The calibration run of retrieval decision 5: the threshold is measured,
// not guessed. For each known question → expected chunk pair, retrieve with
// the threshold disabled (nothing dropped) and print the distance of the
// expected chunk beside the best chunk that is not it. The gap between the
// two columns, across the pairs, is where maxDistance goes.
//
//   pnpm kb:calibrate
//
// PAIRS is hand-picked from the edge-case matrix (internal research §4.3);
// ten pairs is the sketch's number. Chunk ids are `docId@version#sectionRef`.

import {
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  DEFAULT_RETRIEVAL_CONFIG,
  EMBEDDING_DIMENSION,
  OpenAIEmbeddingClient,
  PgKBRepository,
  RetrievalService,
  createDb,
} from '../packages/core/src/index.ts';

/** `expectedChunkId: null` is a negative pair: a question the corpus must not answer; its best distance is what the threshold has to cut. */
type Pair = { storeId: string; question: string; expectedChunkId: string | null };

const PAIRS: Pair[] = [
  {
    storeId: 'loomhaven',
    question: 'Is return shipping free?',
    expectedChunkId: 'LH-RET@1.2#§6',
  },
  {
    storeId: 'loomhaven',
    // question: "I want to return an item. It has no defects. When I purchased it it was marked as final-sale, but since it doesn't have defects I wouldn't expect it to be a problem",
    question: 'return policy on final-sale items',
    expectedChunkId: 'LH-RET@1.2#§4',
  },
  {
    storeId: 'loomhaven',
    question: 'return deadline when an order ships in several parcels',
    expectedChunkId: 'LH-RET@1.2#§2',
  },
  {
    storeId: 'loomhaven',
    question: 'returns for gifted items',
    expectedChunkId: 'LH-RET@1.2#§7',
  },
  {
    storeId: 'loomhaven',
    question: 'gift card refund policy',
    expectedChunkId: 'LH-PAY@1.0#§4',
  },
  {
    storeId: 'averlane',
    question: 'return policy on bundle promos',
    expectedChunkId: 'AV-RET@3.1#§6',
  },
  {
    storeId: 'averlane',
    question: 'refund policy for opened, intact electronics',
    expectedChunkId: 'AV-RET@3.1#§3',
  },
  {
    storeId: 'averlane',
    question: 'refund policy for damaged items reported on day 3',
    expectedChunkId: 'AV-RET@3.1#§5',
  },
  {
    storeId: 'averlane',
    question: 'advantage member return policy on partner-sold jacket',
    expectedChunkId: 'AV-RET@3.1#§9',
  },
  {
    storeId: 'averlane',
    question: 'withdrawal policy for e-books',
    expectedChunkId: 'AV-RET@3.1#§13',
  },
  {
    storeId: 'loomhaven',
    question: 'what is your mobile number',
    expectedChunkId: null,
  },
  {
    storeId: 'loomhaven',
    question: 'change my delivery address',
    expectedChunkId: null,
  },
  {
    storeId: 'averlane',
    question: 'how many returns per year',
    expectedChunkId: 'AV-MKT@1.3#§3',
  },
  {
    storeId: 'averlane',
    question: 'price adjustment if an item goes on sale after I ordered',
    expectedChunkId: null,
  },
];

const url = process.env['DATABASE_URL'];
const apiKey = process.env['OPENAI_API_KEY'];
if (!url || !apiKey) {
  throw new Error('DATABASE_URL and OPENAI_API_KEY are required');
}
if (PAIRS.length === 0) {
  throw new Error('PAIRS is empty: add question → expected chunk pairs before calibrating');
}
const model = process.env['KEPT_EMBEDDING_MODEL']?.trim() || DEFAULT_OPENAI_EMBEDDING_MODEL;

const fmt = (value: number | undefined): string =>
  value === undefined ? 'absent'.padEnd(10) : value.toFixed(4).padEnd(10);

const handle = createDb(url, { max: 2 });
try {
  const service = new RetrievalService(
    new OpenAIEmbeddingClient({ model, dimension: EMBEDDING_DIMENSION }, apiKey),
    new PgKBRepository(handle.db),
    // Wide budgets and the maximum cosine distance: nothing is dropped, so
    // every distance is visible.
    { ...DEFAULT_RETRIEVAL_CONFIG, topKBinding: 10, topKInformational: 10, maxDistance: 0.66 },
  );
  const asOf = Date.now();
  console.log('expected'.padEnd(10), 'best-other'.padEnd(10), 'gap'.padEnd(8), 'question');
  for (const pair of PAIRS) {
    // oxlint-disable-next-line no-await-in-loop -- one question at a time, readable output
    const result = await service.retrieve(pair.question, { storeId: pair.storeId, asOf });
    // Rank by distance across both tiers: the service orders binding first,
    // which is right for the model and wrong for this table.
    const ranked = result.chunks.toSorted((a, b) => a.distance - b.distance);
    const expected = pair.expectedChunkId
      ? ranked.find((chunk) => chunk.id === pair.expectedChunkId)
      : undefined;
    const bestWrong = ranked.find((chunk) => chunk.id !== pair.expectedChunkId);
    const gap = expected && bestWrong ? (bestWrong.distance - expected.distance).toFixed(4) : 'n/a';
    console.log(
      pair.expectedChunkId === null ? 'none'.padEnd(10) : fmt(expected?.distance),
      fmt(bestWrong?.distance),
      gap.padEnd(8),
      pair.question,
    );
    // The top three, tiers mixed, so a "miss" that is really the co-deciding
    // clause or a help-tier twin is visible at a glance.
    const top = ranked.slice(0, 3).map((c) => `${c.id} (${c.tier[0]} ${c.distance.toFixed(3)})`);
    console.log(`  top: ${top.join(' · ')}`);
    if (pair.expectedChunkId !== null && !expected) {
      console.log(`  expected ${pair.expectedChunkId} not in the top results`);
    }
  }
} finally {
  await handle.close();
}
