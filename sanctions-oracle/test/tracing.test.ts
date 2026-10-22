import {
  DefaultTracer,
  NoopTracer,
  type SpanData,
  type TracingOptions,
} from '../src/tracing';
import { syncSanctionsToDenylist, DenylistWriter } from '../src/sync';
import { MockSanctionsProvider, MOCK_FLAGGED_ADDRESSES } from '../src/mockProvider';

const FLAGGED_ADDRESS = Object.keys(MOCK_FLAGGED_ADDRESSES)[0];
const CLEAN_ADDRESS = 'GDUMBFZF42V5HQCHSHZE3UHUUMDJPPLA6YLFAQG7NWAUHZBZSBJY4AT3';

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

function makeFakeWriter(): DenylistWriter & { addToDenylist: jest.Mock } {
  return {
    addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }),
  };
}

// ── syncSanctionsToDenylist tracing integration ───────────────────────────────

describe('syncSanctionsToDenylist tracing integration', () => {
  it('produces address_check and denylist_write spans with correct status', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const { tracer, spans } = makeTracer();

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      tracer,
    });

    await tracer.shutdown();

    const checkSpans = spans.filter((s) => s.name === 'address_check');
    const writeSpans = spans.filter((s) => s.name === 'denylist_write');

    // Two addresses → two address_check spans
    expect(checkSpans).toHaveLength(2);
    expect(checkSpans.every((s) => s.status === 'ok')).toBe(true);

    // One flagged address → one denylist_write span
    expect(writeSpans).toHaveLength(1);
    expect(writeSpans[0].status).toBe('ok');
    expect(writeSpans[0].attributes['denylist_write.tx_hash']).toBe('fakehash');
  });

  it('address_check span records the flagged attribute', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const { tracer, spans } = makeTracer();

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      tracer,
    });

    await tracer.shutdown();

    const checkSpan = spans.find((s) => s.name === 'address_check')!;
    expect(checkSpan.attributes['address_check.flagged']).toBe(true);
  });

  it('does NOT attach stellar addresses to spans (payload redaction)', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const { tracer, spans } = makeTracer();

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      tracer,
    });

    await tracer.shutdown();

    for (const span of spans) {
      const values = Object.values(span.attributes);
      expect(values).not.toContain(FLAGGED_ADDRESS);
    }
  });

  it('address_check span status is error when provider throws', async () => {
    const provider = {
      checkAddress: jest.fn().mockRejectedValue(new Error('provider down')),
    };
    const writer = makeFakeWriter();
    const { tracer, spans } = makeTracer();

    await expect(
      syncSanctionsToDenylist({ provider, addresses: [FLAGGED_ADDRESS], writer, tracer }),
    ).rejects.toThrow('provider down');

    await tracer.shutdown();

    const checkSpan = spans.find((s) => s.name === 'address_check')!;
    expect(checkSpan.status).toBe('error');
    expect(checkSpan.errorMessage).toBe('provider down');
  });

  it('denylist_write span status is error when writer throws', async () => {
    const provider = new MockSanctionsProvider();
    const writer: DenylistWriter = {
      addToDenylist: jest.fn().mockRejectedValue(new Error('rpc write failed')),
    };
    const { tracer, spans } = makeTracer();

    await expect(
      syncSanctionsToDenylist({ provider, addresses: [FLAGGED_ADDRESS], writer, tracer }),
    ).rejects.toThrow('rpc write failed');

    await tracer.shutdown();

    const writeSpan = spans.find((s) => s.name === 'denylist_write')!;
    expect(writeSpan.status).toBe('error');
    expect(writeSpan.errorMessage).toBe('rpc write failed');
  });

  it('dry-run mode produces no denylist_write spans', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const { tracer, spans } = makeTracer();

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      dryRun: true,
      tracer,
    });

    await tracer.shutdown();

    const writeSpans = spans.filter((s) => s.name === 'denylist_write');
    expect(writeSpans).toHaveLength(0);
    // address_check spans are still recorded
    expect(spans.filter((s) => s.name === 'address_check')).toHaveLength(1);
  });

  it('works without a tracer (no-op default)', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      // no tracer — should use NoopTracer silently
    });

    expect(result.written).toEqual([FLAGGED_ADDRESS]);
  });
});

// ── DefaultTracer shutdown and cancellation ───────────────────────────────────

describe('sanctions-oracle DefaultTracer shutdown and cancellation', () => {
  it('shutdown() resolves even when no exporter is configured', async () => {
    const tracer = new DefaultTracer();
    const span = tracer.startSpan('address_check');
    span.end('ok');
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown() resolves after all in-flight exports settle', async () => {
    const settled: string[] = [];
    let trigger: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      trigger = res;
    });

    const tracer = new DefaultTracer({
      exporter: () =>
        gate.then(() => {
          settled.push('done');
        }),
    });

    const span = tracer.startSpan('denylist_write');
    span.end('ok');

    const shutdownPromise = tracer.shutdown();
    trigger!();
    await shutdownPromise;

    expect(settled).toEqual(['done']);
  });

  it('exporter failures during shutdown do not cause rejection', async () => {
    const errors: unknown[] = [];
    const tracer = new DefaultTracer({
      exporter: async () => {
        throw new Error('export blew up');
      },
      onExportError: (e) => errors.push(e),
    });

    const span = tracer.startSpan('address_check');
    span.end('ok');

    await expect(tracer.shutdown()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('spans started after shutdown are no-ops and produce no exports', async () => {
    const { tracer, spans } = makeTracer();
    await tracer.shutdown();

    const span = tracer.startSpan('address_check');
    span.end('ok');

    expect(spans).toHaveLength(0);
  });

  it('cancellation: sampler returning false suppresses all spans', async () => {
    const { tracer, spans } = makeTracer({ sampler: () => false });

    const span1 = tracer.startSpan('address_check');
    const span2 = tracer.startSpan('denylist_write');
    span1.end('ok');
    span2.end('ok');
    await tracer.shutdown();

    expect(spans).toHaveLength(0);
  });
});

// ── NoopTracer ────────────────────────────────────────────────────────────────

describe('sanctions-oracle NoopTracer', () => {
  it('spans are no-ops: empty ids, setAttribute and end do nothing', () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan('address_check');
    expect(span.traceId).toBe('');
    expect(span.spanId).toBe('');
    expect(() => {
      span.setAttribute('key', 'val');
      span.end('ok');
    }).not.toThrow();
  });

  it('extractContext always returns undefined', () => {
    const tracer = new NoopTracer();
    expect(
      tracer.extractContext('00-' + 'a'.repeat(32) + '-' + 'b'.repeat(16) + '-01'),
    ).toBeUndefined();
  });

  it('shutdown resolves immediately', async () => {
    const tracer = new NoopTracer();
    await expect(tracer.shutdown()).resolves.toBeUndefined();
  });
});
