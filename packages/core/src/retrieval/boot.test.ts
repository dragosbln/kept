import { describe, expect, it } from 'vitest';
import {
  EmbeddingModelCheckError,
  assertStoreEmbeddingModel,
  checkEmbeddingModelsAgree,
} from './boot.js';
import { FakeEmbeddingClient } from './embedding/fake.js';
import { ScriptedKBRepository } from './testing.js';

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof EmbeddingModelCheckError
      ? error.code
      : 'not an EmbeddingModelCheckError';
  }
};

describe('checkEmbeddingModelsAgree (decision 2)', () => {
  it('passes when the store holds exactly the client model', () => {
    expect(
      codeOf(() => checkEmbeddingModelsAgree(['m1'], 'm1', { allowEmpty: false })),
    ).toBeUndefined();
  });

  it('refuses an empty store at boot and allows it at ingest', () => {
    expect(codeOf(() => checkEmbeddingModelsAgree([], 'm1', { allowEmpty: false }))).toBe(
      'no_corpus',
    );
    expect(codeOf(() => checkEmbeddingModelsAgree([], 'm1', { allowEmpty: true }))).toBeUndefined();
  });

  it('refuses a store embedded under more than one model', () => {
    expect(codeOf(() => checkEmbeddingModelsAgree(['m1', 'm2'], 'm1', { allowEmpty: true }))).toBe(
      'multiple_embedding_models_in_store',
    );
  });

  it('refuses a client whose model differs from the store', () => {
    expect(codeOf(() => checkEmbeddingModelsAgree(['m1'], 'm2', { allowEmpty: true }))).toBe(
      'embedding_model_mismatch',
    );
  });
});

describe('assertStoreEmbeddingModel', () => {
  it('reads the store models through the repository and checks the client against them', async () => {
    const client = new FakeEmbeddingClient({ model: 'fake-a', dimension: 8 });
    await expect(
      assertStoreEmbeddingModel(new ScriptedKBRepository({}, ['fake-a']), client, 's', {
        allowEmpty: false,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertStoreEmbeddingModel(new ScriptedKBRepository({}, ['fake-b']), client, 's', {
        allowEmpty: false,
      }),
    ).rejects.toMatchObject({ code: 'embedding_model_mismatch' });
  });

  it('refuses a client whose vector width differs from the column', async () => {
    const client = new FakeEmbeddingClient({ model: 'fake-a', dimension: 8 });
    await expect(
      assertStoreEmbeddingModel(new ScriptedKBRepository({}, ['fake-a']), client, 's', {
        allowEmpty: false,
        expectedDimension: 1536,
      }),
    ).rejects.toMatchObject({ code: 'embedding_dimension_mismatch' });
  });
});
