import {
  DefaultTracer,
  NoopTracer,
  type SpanData,
  type TracingOptions,
} from '../src/tracing';
import { HorizonListener } from '../src/listener';
import { HttpWebhookSender } from '../src/webhook';
import type { EventSource, RawContractEvent } from '../src/eventSource';

function makeEvent(overrides: Partial<RawContractEvent> = {}): RawContractEvent {
  return {
    id: 'evt-1',
    contractId: 'CDENYLISTGATE',
    ledger: 1,
    topic: ['denylist_added'],
    value: {},
    ...overrides,
  };
}

function makeTracer(opts: TracingOptions = {}): { tracer: DefaultTracer; spans: SpanData[] } {
  const spans: SpanData[] = [];
  const tracer = new DefaultTracer({
    ...opts,
    exporter: async (span) => {
      spans.push(span);
      await opts.exporter?.(span);
    },
  });
  return { tracer, spans };
}

// ── DefaultTracer unit tests ──────────────────────────────────────────────────

describe('DefaultTracer', () => {
  it('produces a span with a valid 32-hex traceId and 16-hex spanId', async () => {
    const { tracer, spans } = makeTracer();
    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    await tracer.shutdown();

    expect(spans).toHaveLength(1);
    expect(spans[0].traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0].spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spans[0].name).toBe('rpc_poll');
    expect(spans[0].status).toBe('ok');
  });

  it('child span shares traceId with parent and records parentSpanId', async () => {
    const { tracer, spans } = makeTracer();

    const parent = tracer.startSpan('rpc_poll');
    const child = tracer.startSpan('event_relay', {
      traceId: parent.traceId,
      spanId: parent.spanId,
    });

    child.end('ok');
    parent.end('ok');
    await tracer.shutdown();

    const parentData = spans.find((s) => s.name === 'rpc_poll')!;
    const childData = spans.find((s) => s.name === 'event_relay')!;

    expect(parentData).toBeDefined();
    expect(childData).toBeDefined();
    expect(childData.traceId).toBe(parentData.traceId);
    expect(childData.parentSpanId).toBe(parentData.spanId);
    expect(parentData.parentSpanId).toBeUndefined();
  });

  it('records error status and errorMessage when ended with an Error', async () => {
    const { tracer, spans } = makeTracer();
    const span = tracer.startSpan('rpc_poll');
    span.end('error', new Error('rpc unreachable'));
    await tracer.shutdown();

    expect(spans[0].status).toBe('error');
    expect(spans[0].errorMessage).toBe('rpc unreachable');
  });

  it('records cancelled status', async () => {
    const { tracer, spans } = makeTracer();
    const span = tracer.startSpan('rpc_poll');
    span.end('cancelled');
    await tracer.shutdown();

    expect(spans[0].status).toBe('cancelled');
    expect(spans[0].errorMessage).toBeUndefined();
  });

  it('setAttribute values appear in exported span attributes', async () => {
    const { tracer, spans } = makeTracer();
    const span = tracer.startSpan('rpc_poll');
    span.setAttribute('poll.event_count', 3);
    span.setAttribute('service.name', 'test');
    span.end('ok');
    await tracer.shutdown();

    expect(spans[0].attributes['poll.event_count']).toBe(3);
    expect(spans[0].attributes['service.name']).toBe('test');
  });

  it('serviceName is attached to every span as service.name attribute', async () => {
    const { tracer, spans } = makeTracer({ serviceName: 'horizon-listener' });
    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    await tracer.shutdown();

    expect(spans[0].attributes['service.name']).toBe('horizon-listener');
  });

  it('span.end() is idempotent — calling it twice only exports once', async () => {
    const { tracer, spans } = makeTracer();
    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    span.end('error'); // second call should be ignored
    await tracer.shutdown();

    expect(spans).toHaveLength(1);
    expect(spans[0].status).toBe('ok');
  });

  it('durationMs is non-negative', async () => {
    const { tracer, spans } = makeTracer();
    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    await tracer.shutdown();

    expect(spans[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sampler returning false suppresses the span entirely', async () => {
    const { tracer, spans } = makeTracer({ sampler: () => false });
    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    await tracer.shutdown();

    expect(spans).toHaveLength(0);
  });

  it('sampler can selectively sample by span name', async () => {
    const { tracer, spans } = makeTracer({ sampler: (name) => name === 'rpc_poll' });

    const rpcSpan = tracer.startSpan('rpc_poll');
    const webhookSpan = tracer.startSpan('webhook');
    rpcSpan.end('ok');
    webhookSpan.end('ok');
    await tracer.shutdown();

    expect(spans.map((s) => s.name)).toEqual(['rpc_poll']);
  });

  it('exporter errors are swallowed and forwarded to onExportError', async () => {
    const exportErrors: unknown[] = [];
    const tracer = new DefaultTracer({
      exporter: async () => {
        throw new Error('export failed');
      },
      onExportError: (err) => exportErrors.push(err),
    });

    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    await tracer.shutdown();

    expect(exportErrors).toHaveLength(1);
    expect((exportErrors[0] as Error).message).toBe('export failed');
  });

  it('shutdown() waits for in-flight exporter calls to settle', async () => {
    const settled: string[] = [];
    // Use a manual trigger that we control from outside the exporter closure
    let trigger: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      trigger = res;
    });

    const tracer = new DefaultTracer({
      exporter: () =>
        gate.then(() => {
          settled.push('exported');
        }),
    });

    const span = tracer.startSpan('rpc_poll');
    span.end('ok');

    // Start shutdown before the export resolves
    const shutdownPromise = tracer.shutdown();

    // Release the gate so the export can complete, then shutdown should settle
    trigger!();
    await shutdownPromise;

    expect(settled).toEqual(['exported']);
  });

  it('startSpan returns a noop span after shutdown', async () => {
    const { tracer, spans } = makeTracer();
    await tracer.shutdown();

    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    // Should still be 0 — no new exports after shutdown
    expect(spans).toHaveLength(0);
  });
});

// ── Context propagation ───────────────────────────────────────────────────────

describe('DefaultTracer context propagation', () => {
  it('injectContext produces a valid W3C traceparent string', () => {
    const tracer = new DefaultTracer();
    const header = tracer.injectContext({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) });
    expect(header).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });

  it('extractContext parses a valid traceparent header', () => {
    const tracer = new DefaultTracer();
    const traceId = 'c'.repeat(32);
    const spanId = 'd'.repeat(16);
    const ctx = tracer.extractContext(`00-${traceId}-${spanId}-01`);

    expect(ctx).toEqual({ traceId, spanId });
  });

  it('extractContext returns undefined for malformed headers', () => {
    const tracer = new DefaultTracer();
    expect(tracer.extractContext(undefined)).toBeUndefined();
    expect(tracer.extractContext('')).toBeUndefined();
    expect(tracer.extractContext('not-a-traceparent')).toBeUndefined();
    expect(tracer.extractContext('00-tooshort-tooshort-01')).toBeUndefined();
  });

  it('span inherits traceId from an extracted context', async () => {
    const tracer = new DefaultTracer();
    const incomingTraceId = 'e'.repeat(32);
    const incomingSpanId = 'f'.repeat(16);
    const ctx = tracer.extractContext(`00-${incomingTraceId}-${incomingSpanId}-01`)!;

    const spans: SpanData[] = [];
    const tracerWithExporter = new DefaultTracer({
      exporter: (s) => { spans.push(s); },
    });

    const span = tracerWithExporter.startSpan('rpc_poll', ctx);
    span.end('ok');
    await tracerWithExporter.shutdown();

    expect(spans[0].traceId).toBe(incomingTraceId);
    expect(spans[0].parentSpanId).toBe(incomingSpanId);
  });
});

// ── NoopTracer ────────────────────────────────────────────────────────────────

describe('NoopTracer', () => {
  it('startSpan returns a span with empty traceId and spanId', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('rpc_poll');
    expect(span.traceId).toBe('');
    expect(span.spanId).toBe('');
  });

  it('setAttribute and end are no-ops', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('rpc_poll');
    expect(() => {
      span.setAttribute('foo', 'bar');
      span.end('ok');
    }).not.toThrow();
  });

  it('extractContext always returns undefined', () => {
    const tracer = new NoopTracer();
    expect(tracer.extractContext('00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01')).toBeUndefined();
  });

  it('shutdown resolves immediately', async () => {
    const tracer = new NoopTracer();
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });
});

// ── HorizonListener tracing integration ──────────────────────────────────────

describe('HorizonListener tracing integration', () => {
  it('produces a coherent rpc_poll → event_relay span tree', async () => {
    const event = makeEvent({ id: 'evt-traced' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'c1' });

    const eventSource: EventSource = { getEvents };
    const { tracer, spans } = makeTracer();

    const listener = new HorizonListener({
      eventSource,
      onEvent: (_e) => {
        listener.stop();
      },
      sleep: async () => {},
      tracer,
    });

    await listener.start();
    await tracer.shutdown();

    const pollSpan = spans.find((s) => s.name === 'rpc_poll');
    const relaySpan = spans.find((s) => s.name === 'event_relay');

    expect(pollSpan).toBeDefined();
    expect(relaySpan).toBeDefined();
    expect(pollSpan!.status).toBe('ok');
    expect(relaySpan!.status).toBe('ok');

    // Coherent span tree: relay is a child of poll
    expect(relaySpan!.traceId).toBe(pollSpan!.traceId);
    expect(relaySpan!.parentSpanId).toBe(pollSpan!.spanId);
  });

  it('event_relay span carries event.id, contract_id, and ledger attributes', async () => {
    const event = makeEvent({ id: 'evt-attr', contractId: 'CXYZ', ledger: 42 });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'c1' });

    const eventSource: EventSource = { getEvents };
    const { tracer, spans } = makeTracer();

    const listener = new HorizonListener({
      eventSource,
      onEvent: () => {
        listener.stop();
      },
      sleep: async () => {},
      tracer,
    });

    await listener.start();
    await tracer.shutdown();

    const relaySpan = spans.find((s) => s.name === 'event_relay')!;
    expect(relaySpan.attributes['event.id']).toBe('evt-attr');
    expect(relaySpan.attributes['event.contract_id']).toBe('CXYZ');
    expect(relaySpan.attributes['event.ledger']).toBe(42);
  });

  it('rpc_poll span status is error when getEvents throws and error when retrying', async () => {
    const getEvents = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc error'))
      .mockResolvedValueOnce({ events: [], nextCursor: 'c1' });

    const eventSource: EventSource = { getEvents };
    const { tracer, spans } = makeTracer();
    let calls = 0;

    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      sleep: async () => {
        calls++;
        if (calls >= 2) listener.stop();
      },
      tracer,
    });

    await listener.start();
    await tracer.shutdown();

    const pollSpans = spans.filter((s) => s.name === 'rpc_poll');
    expect(pollSpans.some((s) => s.status === 'error')).toBe(true);
    expect(pollSpans.some((s) => s.status === 'ok')).toBe(true);
  });

  it('rpc_poll span is cancelled when maxRetries is exhausted', async () => {
    const getEvents = jest.fn().mockRejectedValue(new Error('always down'));
    const eventSource: EventSource = { getEvents };
    const { tracer, spans } = makeTracer();

    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      maxRetries: 2,
      sleep: async () => {},
      tracer,
    });

    await expect(listener.start()).rejects.toThrow(/giving up/);
    await tracer.shutdown();

    const cancelledSpans = spans.filter((s) => s.status === 'cancelled');
    expect(cancelledSpans.length).toBeGreaterThanOrEqual(1);
  });

  it('event_relay span status is error when onEvent throws', async () => {
    const event = makeEvent({ id: 'evt-err' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'c1' });

    const eventSource: EventSource = { getEvents };
    const { tracer, spans } = makeTracer();
    let threw = false;

    const listener = new HorizonListener({
      eventSource,
      onEvent: () => {
        threw = true;
        throw new Error('handler threw');
      },
      sleep: async () => {
        if (threw) listener.stop();
      },
      tracer,
    });

    await listener.start();
    await tracer.shutdown();

    const relaySpan = spans.find((s) => s.name === 'event_relay')!;
    expect(relaySpan.status).toBe('error');
    expect(relaySpan.errorMessage).toBe('handler threw');
  });

  it('no tracing (no-op default) works without errors', async () => {
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [], nextCursor: 'c1' });

    const eventSource: EventSource = { getEvents };
    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      sleep: async () => {
        listener.stop();
      },
      // no tracer — should use NoopTracer silently
    });

    await expect(listener.start()).resolves.toBeUndefined();
  });
});

// ── HttpWebhookSender tracing integration ─────────────────────────────────────

describe('HttpWebhookSender tracing integration', () => {
  it('webhook span status is ok on 2xx and injects traceparent header', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const { tracer, spans } = makeTracer();

    const sender = new HttpWebhookSender({
      url: 'http://localhost:9999/webhook',
      fetchImpl,
      tracer,
    });

    await sender.send(makeEvent({ id: 'evt-hook' }));
    await tracer.shutdown();

    const webhookSpan = spans.find((s) => s.name === 'webhook')!;
    expect(webhookSpan.status).toBe('ok');
    expect(webhookSpan.attributes['event.id']).toBe('evt-hook');
    expect(webhookSpan.attributes['http.status_code']).toBe(200);

    // traceparent header was injected
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('webhook span status is error on non-2xx response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    const { tracer, spans } = makeTracer();

    const sender = new HttpWebhookSender({
      url: 'http://localhost:9999/webhook',
      fetchImpl,
      tracer,
    });

    await expect(sender.send(makeEvent())).rejects.toThrow(/status 503/);
    await tracer.shutdown();

    const webhookSpan = spans.find((s) => s.name === 'webhook')!;
    expect(webhookSpan.status).toBe('error');
  });

  it('webhook span status is error when fetch throws', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('network error'));
    const { tracer, spans } = makeTracer();

    const sender = new HttpWebhookSender({
      url: 'http://localhost:9999/webhook',
      fetchImpl,
      tracer,
    });

    await expect(sender.send(makeEvent())).rejects.toThrow(/network error/);
    await tracer.shutdown();

    const webhookSpan = spans.find((s) => s.name === 'webhook')!;
    expect(webhookSpan.status).toBe('error');
    expect(webhookSpan.errorMessage).toBe('network error');
  });
});

// ── Shutdown and cancellation ─────────────────────────────────────────────────

describe('DefaultTracer shutdown and cancellation', () => {
  it('shutdown() resolves even when exporter is absent', async () => {
    const tracer = new DefaultTracer();
    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown() resolves even when exporter throws synchronously', async () => {
    const errors: unknown[] = [];
    const tracer = new DefaultTracer({
      exporter: () => {
        throw new Error('sync export error');
      },
      onExportError: (e) => errors.push(e),
    });

    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    await expect(tracer.shutdown()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('spans started after shutdown are no-ops', async () => {
    const { tracer, spans } = makeTracer();
    await tracer.shutdown();

    const span = tracer.startSpan('rpc_poll');
    span.end('ok');
    expect(spans).toHaveLength(0);
  });

  it('multiple concurrent spans all export before shutdown resolves', async () => {
    const spans: SpanData[] = [];
    const delays = [20, 10, 5];
    let i = 0;

    const tracer = new DefaultTracer({
      exporter: (s) =>
        new Promise<void>((res) => {
          setTimeout(() => {
            spans.push(s);
            res();
          }, delays[i++ % delays.length]);
        }),
    });

    const s1 = tracer.startSpan('rpc_poll');
    const s2 = tracer.startSpan('event_relay');
    const s3 = tracer.startSpan('webhook');
    s1.end('ok');
    s2.end('ok');
    s3.end('ok');

    await tracer.shutdown();
    expect(spans).toHaveLength(3);
  });
});
