import type { Message } from '../messages.js';
import type { CallModelResponse, ModelClientConfig } from './types.js';

export interface ModelClient {
  callModel(messages: Message[]): Promise<CallModelResponse>;
  getConfig(): Readonly<ModelClientConfig>;
}
