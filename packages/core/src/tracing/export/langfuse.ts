import type { CompletedTrace } from '../types.js';
import type { TraceExporter } from './exporter.js';
import { mapTraceToOTLPEnvelope } from './otlp.js';

/** Langfuse's OTLP/HTTP ingestion endpoint, relative to the instance base URL. */
const OTLP_TRACES_PATH = '/api/public/otel/v1/traces';

/** Give up on an export POST after this long; the trace is dropped, not retried. */
const EXPORT_TIMEOUT_MS = 10_000;

/**
 * One failed export; the trace was dropped, not retried. `http` means
 * Langfuse answered non-2xx; `exception` means the envelope could not be
 * built or the POST threw (network failure, timeout).
 */
export type ExportErrorEvent =
  | { reason: 'http'; traceId: string; status: number; bodySnippet: string }
  | { reason: 'exception'; traceId: string; error: unknown };

export type LangfuseExporterConfig = {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  /**
   * Failure sink, called once per dropped trace; defaults to console
   * logging. Exceptions thrown by the callback itself are contained.
   */
  onExportError?: (event: ExportErrorEvent) => void;
};

const logExportError = (event: ExportErrorEvent): void => {
  if (event.reason === 'http') {
    console.warn('langfuse export: failed response', {
      traceId: event.traceId,
      status: event.status,
      bodySnippet: event.bodySnippet,
    });
  } else {
    console.error('langfuse export: failed', { traceId: event.traceId }, event.error);
  }
};

/**
 * Best-effort OTLP/HTTP transport to a Langfuse instance — write-side only,
 * per ADR 0001; nothing in core reads Langfuse back. Speaks plain OTLP over
 * fetch(), so no Langfuse SDK is involved. Delivery is at-most-once: a
 * failed export surfaces through onExportError and the trace is dropped,
 * never retried, and export() never throws into the agent loop.
 */
export class LangfuseExporter implements TraceExporter {
  private readonly url: string;
  private readonly authorization: string;
  private readonly onExportError: (event: ExportErrorEvent) => void;

  private pending = new Set<Promise<void>>();

  constructor({ baseUrl, publicKey, secretKey, onExportError }: LangfuseExporterConfig) {
    this.url = `${baseUrl}${OTLP_TRACES_PATH}`;
    this.authorization = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
    this.onExportError = onExportError ?? logExportError;
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
            this.reportFailure({
              reason: 'http',
              traceId: input.id,
              status: res.status,
              bodySnippet: text.slice(0, 200),
            });
          }
        })
        .catch((error) => {
          this.reportFailure({ reason: 'exception', traceId: input.id, error });
        });
      this.pending.add(promise);
      promise.finally(() => this.pending.delete(promise));
    } catch (error) {
      this.reportFailure({ reason: 'exception', traceId: input.id, error });
    }
  }

  /** Resolves once every export started before this call has settled. */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  /** The failure sink is caller-provided code; never let it break the export path. */
  private reportFailure(event: ExportErrorEvent): void {
    try {
      this.onExportError(event);
    } catch (error) {
      console.error('langfuse export: onExportError callback threw', error);
    }
  }
}
