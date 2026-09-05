// Unit tests for the in-memory ConversationStore. The copy-out contract is
// pinned here: the store's state changes only through updateConversationHistory,
// so every exit (find/create/update) returns copies and the seed is copied in.
// The agent loop's failure-atomicity rule depends on this isolation.

import { describe, expect, it } from 'vitest';
import { InMemoryConversationStore } from './in-memory-conversation-store.js';
import type { Conversation } from './types.js';
import type { Message } from '../messages.js';

const userMessage = (content: string): Message => ({
  role: 'user',
  parts: [{ type: 'text', content }],
});

const seededConversation = (): Conversation => ({
  id: 'conv-1',
  messages: [userMessage('Where is my order?')],
});

describe('InMemoryConversationStore', () => {
  it('creates conversations with unique ids and empty history', async () => {
    const store = new InMemoryConversationStore();
    const first = await store.createNewConversation();
    const second = await store.createNewConversation();
    expect(first.messages).toEqual([]);
    expect(second.id).not.toBe(first.id);
  });

  it('finds a conversation it created', async () => {
    const store = new InMemoryConversationStore();
    const created = await store.createNewConversation();
    const found = await store.findConversation(created.id);
    expect(found).toMatchObject({ id: created.id, messages: [] });
  });

  it('finds seeded conversations', async () => {
    const store = new InMemoryConversationStore([seededConversation()]);
    const found = await store.findConversation('conv-1');
    expect(found?.messages).toEqual([userMessage('Where is my order?')]);
  });

  it('returns null for an unknown id', async () => {
    const store = new InMemoryConversationStore([seededConversation()]);
    expect(await store.findConversation('no-such-id')).toBeNull();
  });

  it('replaces history on update rather than appending', async () => {
    const store = new InMemoryConversationStore([seededConversation()]);
    const updatedHistory = [userMessage('first'), userMessage('second')];
    const updated = await store.updateConversationHistory('conv-1', updatedHistory);
    expect(updated.messages).toEqual(updatedHistory);
  });

  it('persists an update: a later find sees the new history', async () => {
    const store = new InMemoryConversationStore([seededConversation()]);
    await store.updateConversationHistory('conv-1', [userMessage('rewritten')]);
    const found = await store.findConversation('conv-1');
    expect(found?.messages).toEqual([userMessage('rewritten')]);
  });

  it('throws when updating a conversation that does not exist', async () => {
    const store = new InMemoryConversationStore();
    await expect((async () => store.updateConversationHistory('no-such-id', []))()).rejects.toThrow(
      /no-such-id/,
    );
  });

  it('copies the history it is handed: mutating the array after update does not reach the store', async () => {
    const store = new InMemoryConversationStore([seededConversation()]);
    const updatedHistory = [userMessage('final')];
    await store.updateConversationHistory('conv-1', updatedHistory);
    updatedHistory.push(userMessage('sneaky late append'));
    const found = await store.findConversation('conv-1');
    expect(found?.messages).toEqual([userMessage('final')]);
  });

  it('returns copies from find: mutating the result does not change store state', async () => {
    const store = new InMemoryConversationStore([seededConversation()]);
    const found = await store.findConversation('conv-1');
    found!.messages.push(userMessage('mutation through find'));
    const foundAgain = await store.findConversation('conv-1');
    expect(foundAgain?.messages).toEqual([userMessage('Where is my order?')]);
  });

  it('returns copies from create: mutating the result does not change store state', async () => {
    const store = new InMemoryConversationStore();
    const created = await store.createNewConversation();
    created.messages.push(userMessage('mutation through create'));
    const found = await store.findConversation(created.id);
    expect(found?.messages).toEqual([]);
  });

  it('returns copies from update: mutating the result does not change store state', async () => {
    const store = new InMemoryConversationStore([seededConversation()]);
    const updated = await store.updateConversationHistory('conv-1', [userMessage('final')]);
    updated.messages.push(userMessage('mutation through update'));
    const found = await store.findConversation('conv-1');
    expect(found?.messages).toEqual([userMessage('final')]);
  });

  it('copies the seed: mutating it after construction does not change store state', async () => {
    const seed = seededConversation();
    const store = new InMemoryConversationStore([seed]);
    seed.messages.push(userMessage('mutation through seed'));
    const found = await store.findConversation('conv-1');
    expect(found?.messages).toEqual([userMessage('Where is my order?')]);
  });
});
