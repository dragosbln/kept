import { createHash } from 'node:crypto';
import type { PromptData, PromptName, PromptRegistry } from './types.js';
import type { PromptManager } from './prompt-manager.js';
import { PROMPT_REGISTRY } from './versioned-prompts.js';

export class CodePromptManager implements PromptManager {
  private promptRegistry: PromptRegistry;

  constructor(promptRegistry?: PromptRegistry) {
    this.promptRegistry = promptRegistry ?? PROMPT_REGISTRY;
  }

  private hashPromptText(text: string): string {
    return createHash('sha256').update(text).digest('hex');
  }

  async getVersionedPromptData(name: PromptName, version: string): Promise<PromptData> {
    const versionedPrompt = this.promptRegistry[name][version];
    if (!versionedPrompt) {
      throw new Error(`Prompt ${name} with version ${version} doesn't exist`);
    }
    return {
      name,
      version,
      hash: this.hashPromptText(versionedPrompt),
      text: versionedPrompt,
    };
  }
}
