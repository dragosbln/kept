// Unit tests for the transport's failure policy: export() never throws into
// the caller, failures surface through onExportError (console by default),
// and flush() awaits everything in flight. All fetch calls are stubbed —
// the real ingestion path is covered by the one smoke test (ADR 0001).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Trace } from '../trace.js';
import type { CompletedTrace, TraceConfig } from '../types.js';
import { LangfuseExporter, type ExportErrorEvent } from './langfuse.js';

const exporterConfig = {
  baseUrl: 'https://langfuse.internal.test',
  publicKey: 'pk-test',
  secretKey: 'sk-test',
};

const traceConfig: TraceConfig = {
  sessionId: 'session-1',
  providerName: 'anthropic',
  promptName: 'support-agent',
  promptVersion: 'test-1',
  promptHash: 'cafebabe',
  backendKind: 'demo',
};

function completedTrace(): CompletedTrace {
  return new Trace(traceConfig).end();
}

describe('LangfuseExporter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the envelope with basic auth and reports nothing on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const onExportError = vi.fn();
    const exporter = new LangfuseExporter({ ...exporterConfig, onExportError });

    exporter.export(completedTrace());
    await exporter.flush();

    expect(onExportError).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://langfuse.internal.test/api/public/otel/v1/traces');
    expect(init.headers.Authorization).toBe(
      'Basic ' + Buffer.from('pk-test:sk-test').toString('base64'),
    );
  });

  it('reports a failed response through onExportError instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ingestion rejected', { status: 401 })),
    );
    const events: ExportErrorEvent[] = [];
    const exporter = new LangfuseExporter({
      ...exporterConfig,
      onExportError: (event) => events.push(event),
    });

    const trace = completedTrace();
    exporter.export(trace);
    await exporter.flush();

    expect(events).toEqual([
      { reason: 'http', traceId: trace.id, status: 401, bodySnippet: 'ingestion rejected' },
    ]);
  });

  it('swallows a network failure and keeps flush() resolving', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const events: ExportErrorEvent[] = [];
    const exporter = new LangfuseExporter({
      ...exporterConfig,
      onExportError: (event) => events.push(event),
    });

    const trace = completedTrace();
    expect(() => exporter.export(trace)).not.toThrow();
    await expect(exporter.flush()).resolves.toBeUndefined();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'exception', traceId: trace.id });
  });

  it('never throws even when the envelope cannot be serialized', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const events: ExportErrorEvent[] = [];
    const exporter = new LangfuseExporter({
      ...exporterConfig,
      onExportError: (event) => events.push(event),
    });

    // BigInt args make JSON.stringify throw inside the envelope mapping.
    const trace = new Trace(traceConfig);
    trace
      .startToolExecutionSpan(null, { callId: 'c1', toolName: 'lookup_order', args: { n: 1n } })
      .end({ resultState: 'ok', result: {} });

    expect(() => exporter.export(trace.end())).not.toThrow();
    await exporter.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ reason: 'exception' });
  });

  it('contains a throwing onExportError callback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const exporter = new LangfuseExporter({
        ...exporterConfig,
        onExportError: () => {
          throw new Error('reporting is broken');
        },
      });

      exporter.export(completedTrace());
      await expect(exporter.flush()).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs through console when no onExportError is configured', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const exporter = new LangfuseExporter(exporterConfig);
      exporter.export(completedTrace());
      await exporter.flush();
      expect(consoleWarn).toHaveBeenCalledOnce();
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
