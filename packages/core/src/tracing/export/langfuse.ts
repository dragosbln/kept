import type { CompletedTrace } from '../types.js';
import type { TraceExporter } from './exporter.js';
import { mapTraceToOTLPEnvelope } from './otlp.js';

/** Langfuse's OTLP/HTTP ingestion endpoint, relative to the instance base URL. */
const OTLP_TRACES_PATH = '/api/public/otel/v1/traces';

/** Give up on an export POST after this long; the trace is dropped, not retried. */
const EXPORT_TIMEOUT_MS = 10_000;

type LangfuseExporterConfig = {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
};

/**
 * Best-effort OTLP/HTTP transport to a Langfuse instance — write-side only,
 * per ADR 0001; nothing in core reads Langfuse back. Speaks plain OTLP over
 * fetch(), so no Langfuse SDK is involved. Delivery is at-most-once: a
 * failed POST is logged and the trace is dropped, never retried, and
 * export() never throws into the agent loop.
 */
export class LangfuseExporter implements TraceExporter {
  private readonly url: string;
  private readonly authorization: string;

  private pending = new Set<Promise<void>>();

  constructor({ baseUrl, publicKey, secretKey }: LangfuseExporterConfig) {
    this.url = `${baseUrl}${OTLP_TRACES_PATH}`;
    this.authorization = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  }

  export(input: CompletedTrace): void {
    try {
      const envelope = mapTraceToOTLPEnvelope(input);
      const promise = fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: this.authorization,
        },
        signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
        body: JSON.stringify(envelope),
      })
        .then(async (res) => {
          // Read the body on every path: undici returns the connection to
          // its keep-alive pool only once the body has been consumed.
          const text = await res.text();
          if (!res.ok) {
            console.warn('langfuse export: Failed response', {
              status: res.status,
              textSnippet: `${text.slice(0, 200)}...`,
            });
          }
        })
        .catch((error) => {
          console.error('langfuse export: Network failure', error);
        });
      this.pending.add(promise);
      promise.finally(() => this.pending.delete(promise));
    } catch (error) {
      console.error('langfuse export: ', error);
    }
  }

  /** Resolves once every export started before this call has settled. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
}
