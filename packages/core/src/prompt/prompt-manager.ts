import type { PromptData, PromptName } from './types.js';

export interface PromptManager {
  getVersionedPromptData(name: PromptName, version: string): Promise<PromptData>;
}
