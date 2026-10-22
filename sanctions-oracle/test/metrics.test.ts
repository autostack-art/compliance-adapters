import { MetricsRegistry, NoopMetricsRegistry, DEFAULT_HISTOGRAM_BUCKETS } from '../src/metrics';
import { syncSanctionsToDenylist, DenylistWriter } from '../src/sync';
import { MockSanctionsProvider, MOCK_FLAGGED_ADDRESSES } from '../src/mockProvider';

const FLAGGED_ADDRESS = Object.keys(MOCK_FLAGGED_ADDRESSES)[0];
const CLEAN_ADDRESS = 'GDUMBFZF42V5HQCHSHZE3UHUUMDJPPLA6YLFAQG7NWAUHZBZSBJY4AT3';

function makeFakeWriter(): DenylistWriter & { addToDenylist: jest.Mock } {
  return {
    addToDenylist: jest.fn().mockResolvedValue({ hash: 'fakehash' }),
  };
}

// ── MetricsRegistry unit tests ────────────────────────────────────────────────

describe('sanctions-oracle MetricsRegistry', () => {
  it('starts all counters at zero', () => {
    const reg = new MetricsRegistry();
    expect(reg.counter.get('address_check', 'success')).toBe(0);
    expect(reg.counter.get('address_check', 'failure')).toBe(0);
    expect(reg.counter.get('denylist_write', 'success')).toBe(0);
    expect(reg.counter.get('denylist_write', 'cancelled')).toBe(0);
  });

  it('increments counters independently per phase and outcome', () => {
    const reg = new MetricsRegistry();
    reg.counter.inc('address_check', 'success');
    reg.counter.inc('address_check', 'success');
    reg.counter.inc('address_check', 'failure');
    reg.counter.inc('denylist_write', 'success');

    expect(reg.counter.get('address_check', 'success')).toBe(2);
    expect(reg.counter.get('address_check', 'failure')).toBe(1);
    expect(reg.counter.get('denylist_write', 'success')).toBe(1);
    expect(reg.counter.get('denylist_write', 'failure')).toBe(0);
  });

  it('histogram snapshot returns correct count, sum, and bucket cumulative counts', () => {
    const reg = new MetricsRegistry({ histogramBuckets: [10, 100, 1000] });
    reg.histogram.observe('address_check', 5);
    reg.histogram.observe('address_check', 50);
    reg.histogram.observe('address_check', 500);
    reg.histogram.observe('address_check', 2000);

    const snap = reg.histogram.snapshot('address_check');
    expect(snap.count).toBe(4);
    expect(snap.sum).toBe(2555);
    expect(snap.buckets.get(10)).toBe(1);
    expect(snap.buckets.get(100)).toBe(2);
    expect(snap.buckets.get(1000)).toBe(3);
    expect(snap.buckets.get('+Inf')).toBe(4);
  });

  it('histogram snapshot for a phase with no observations returns zeros', () => {
    const reg = new MetricsRegistry();
    const snap = reg.histogram.snapshot('denylist_write');
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
    expect(snap.buckets.get('+Inf')).toBe(0);
  });

  it('expose() contains metric names, phase labels, and correct counter values', () => {
    const reg = new MetricsRegistry();
    reg.counter.inc('address_check', 'success');
    reg.counter.inc('address_check', 'success');
    reg.counter.inc('denylist_write', 'failure');

    const output = reg.expose();

    expect(output).toContain('# HELP sanctions_oracle_requests_total');
    expect(output).toContain('# TYPE sanctions_oracle_requests_total counter');
    expect(output).toContain('# TYPE sanctions_oracle_duration_ms histogram');

    expect(output).toContain(
      'sanctions_oracle_requests_total{phase="address_check",outcome="success"} 2',
    );
    expect(output).toContain(
      'sanctions_oracle_requests_total{phase="denylist_write",outcome="failure"} 1',
    );
    // Zero-value counters are still emitted
    expect(output).toContain(
      'sanctions_oracle_requests_total{phase="address_check",outcome="failure"} 0',
    );
  });

  it('expose() respects a custom prefix', () => {
    const reg = new MetricsRegistry({ prefix: 'my_oracle' });
    const output = reg.expose();
    expect(output).toContain('my_oracle_requests_total');
    expect(output).not.toContain('sanctions_oracle_requests_total');
  });

  it('expose() includes histogram bucket lines for all phases', () => {
    const reg = new MetricsRegistry({ histogramBuckets: [50] });
    reg.histogram.observe('denylist_write', 20);

    const output = reg.expose();
    expect(output).toContain(
      'sanctions_oracle_duration_ms_bucket{phase="denylist_write",le="50"} 1',
    );
    expect(output).toContain(
      'sanctions_oracle_duration_ms_bucket{phase="denylist_write",le="+Inf"} 1',
    );
    expect(output).toContain('sanctions_oracle_duration_ms_count{phase="denylist_write"} 1');
    expect(output).toContain('sanctions_oracle_duration_ms_sum{phase="denylist_write"} 20');
  });

  it('DEFAULT_HISTOGRAM_BUCKETS is sorted ascending', () => {
    for (let i = 1; i < DEFAULT_HISTOGRAM_BUCKETS.length; i++) {
      expect(DEFAULT_HISTOGRAM_BUCKETS[i]).toBeGreaterThan(DEFAULT_HISTOGRAM_BUCKETS[i - 1]);
    }
  });
});

// ── NoopMetricsRegistry ───────────────────────────────────────────────────────

describe('sanctions-oracle NoopMetricsRegistry', () => {
  it('all counter gets return 0 and inc is a no-op', () => {
    const noop = new NoopMetricsRegistry();
    noop.counter.inc('address_check', 'success');
    expect(noop.counter.get('address_check', 'success')).toBe(0);
  });

  it('histogram observe is a no-op and snapshot returns zeros', () => {
    const noop = new NoopMetricsRegistry();
    noop.histogram.observe('denylist_write', 99);
    const snap = noop.histogram.snapshot('denylist_write');
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
  });

  it('expose() returns an empty string', () => {
    const noop = new NoopMetricsRegistry();
    expect(noop.expose()).toBe('');
  });
});

// ── syncSanctionsToDenylist integration with metrics ─────────────────────────

describe('syncSanctionsToDenylist metrics integration', () => {
  it('records address_check success for each address and denylist_write success for flagged', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const metrics = new MetricsRegistry();

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS, CLEAN_ADDRESS],
      writer,
      metrics,
    });

    expect(metrics.counter.get('address_check', 'success')).toBe(2);
    expect(metrics.counter.get('denylist_write', 'success')).toBe(1);
    expect(metrics.counter.get('address_check', 'failure')).toBe(0);
    expect(metrics.counter.get('denylist_write', 'failure')).toBe(0);
    // Histogram should have one observation per address_check call
    expect(metrics.histogram.snapshot('address_check').count).toBe(2);
    expect(metrics.histogram.snapshot('denylist_write').count).toBe(1);
  });

  it('records address_check failure when provider throws', async () => {
    const provider = {
      checkAddress: jest.fn().mockRejectedValue(new Error('provider down')),
    };
    const writer = makeFakeWriter();
    const metrics = new MetricsRegistry();

    await expect(
      syncSanctionsToDenylist({ provider, addresses: [FLAGGED_ADDRESS], writer, metrics }),
    ).rejects.toThrow('provider down');

    expect(metrics.counter.get('address_check', 'failure')).toBe(1);
    expect(metrics.counter.get('address_check', 'success')).toBe(0);
  });

  it('records denylist_write failure when writer throws', async () => {
    const provider = new MockSanctionsProvider();
    const writer: DenylistWriter = {
      addToDenylist: jest.fn().mockRejectedValue(new Error('rpc write failed')),
    };
    const metrics = new MetricsRegistry();

    await expect(
      syncSanctionsToDenylist({ provider, addresses: [FLAGGED_ADDRESS], writer, metrics }),
    ).rejects.toThrow('rpc write failed');

    expect(metrics.counter.get('denylist_write', 'failure')).toBe(1);
    expect(metrics.counter.get('denylist_write', 'success')).toBe(0);
  });

  it('does not record denylist_write in dry-run mode', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();
    const metrics = new MetricsRegistry();

    await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      dryRun: true,
      metrics,
    });

    expect(metrics.counter.get('address_check', 'success')).toBe(1);
    // dry-run skips writer entirely — no denylist_write observations
    expect(metrics.counter.get('denylist_write', 'success')).toBe(0);
    expect(metrics.histogram.snapshot('denylist_write').count).toBe(0);
  });

  it('works without a metrics registry (no-op default)', async () => {
    const provider = new MockSanctionsProvider();
    const writer = makeFakeWriter();

    // Should resolve without errors and with no user-visible effect
    const result = await syncSanctionsToDenylist({
      provider,
      addresses: [FLAGGED_ADDRESS],
      writer,
      // no metrics field
    });

    expect(result.written).toEqual([FLAGGED_ADDRESS]);
  });
});
