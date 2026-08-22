import type { CompletedTrace } from '../types.js';

export interface TraceExporter {
  export(input: CompletedTrace): void;
  flush(): Promise<void>;
}
