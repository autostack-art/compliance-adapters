import { MetricsRegistry, NoopMetricsRegistry, DEFAULT_HISTOGRAM_BUCKETS } from '../src/metrics';
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

// ── MetricsRegistry unit tests ────────────────────────────────────────────────

describe('MetricsRegistry', () => {
  it('starts all counters at zero', () => {
    const reg = new MetricsRegistry();
    expect(reg.counter.get('rpc_poll', 'success')).toBe(0);
    expect(reg.counter.get('rpc_poll', 'failure')).toBe(0);
    expect(reg.counter.get('event_relay', 'success')).toBe(0);
    expect(reg.counter.get('webhook', 'cancelled')).toBe(0);
  });

  it('increments counters independently per phase and outcome', () => {
    const reg = new MetricsRegistry();
    reg.counter.inc('rpc_poll', 'success');
    reg.counter.inc('rpc_poll', 'success');
    reg.counter.inc('rpc_poll', 'failure');
    reg.counter.inc('event_relay', 'success');

    expect(reg.counter.get('rpc_poll', 'success')).toBe(2);
    expect(reg.counter.get('rpc_poll', 'failure')).toBe(1);
    expect(reg.counter.get('event_relay', 'success')).toBe(1);
    // Unrelated counter must not be affected
    expect(reg.counter.get('webhook', 'success')).toBe(0);
  });

  it('histogram snapshot returns correct count, sum, and bucket cumulative counts', () => {
    const reg = new MetricsRegistry({ histogramBuckets: [10, 100, 1000] });
    reg.histogram.observe('rpc_poll', 5);
    reg.histogram.observe('rpc_poll', 50);
    reg.histogram.observe('rpc_poll', 500);
    reg.histogram.observe('rpc_poll', 2000);

    const snap = reg.histogram.snapshot('rpc_poll');
    expect(snap.count).toBe(4);
    expect(snap.sum).toBe(2555);
    // le=10: only 5ms ≤ 10
    expect(snap.buckets.get(10)).toBe(1);
    // le=100: 5ms + 50ms ≤ 100
    expect(snap.buckets.get(100)).toBe(2);
    // le=1000: 5 + 50 + 500 ≤ 1000
    expect(snap.buckets.get(1000)).toBe(3);
    // +Inf always equals total count
    expect(snap.buckets.get('+Inf')).toBe(4);
  });

  it('histogram snapshot for a phase with no observations returns zeros', () => {
    const reg = new MetricsRegistry();
    const snap = reg.histogram.snapshot('event_relay');
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
    expect(snap.buckets.get('+Inf')).toBe(0);
  });

  it('expose() contains metric names, phase labels, and correct counter values', () => {
    const reg = new MetricsRegistry();
    reg.counter.inc('rpc_poll', 'success');
    reg.counter.inc('rpc_poll', 'success');
    reg.counter.inc('event_relay', 'failure');

    const output = reg.expose();

    // Prometheus HELP and TYPE lines
    expect(output).toContain('# HELP horizon_listener_requests_total');
    expect(output).toContain('# TYPE horizon_listener_requests_total counter');
    expect(output).toContain('# TYPE horizon_listener_duration_ms histogram');

    // Counter values
    expect(output).toContain(
      'horizon_listener_requests_total{phase="rpc_poll",outcome="success"} 2',
    );
    expect(output).toContain(
      'horizon_listener_requests_total{phase="event_relay",outcome="failure"} 1',
    );
    // Zero-value counters are still emitted (complete time-series)
    expect(output).toContain(
      'horizon_listener_requests_total{phase="webhook",outcome="success"} 0',
    );
  });

  it('expose() respects a custom prefix', () => {
    const reg = new MetricsRegistry({ prefix: 'my_service' });
    const output = reg.expose();
    expect(output).toContain('my_service_requests_total');
    expect(output).not.toContain('horizon_listener_requests_total');
  });

  it('expose() includes histogram bucket lines for all phases', () => {
    const reg = new MetricsRegistry({ histogramBuckets: [50] });
    reg.histogram.observe('rpc_poll', 20);

    const output = reg.expose();
    expect(output).toContain('horizon_listener_duration_ms_bucket{phase="rpc_poll",le="50"} 1');
    expect(output).toContain('horizon_listener_duration_ms_bucket{phase="rpc_poll",le="+Inf"} 1');
    expect(output).toContain('horizon_listener_duration_ms_count{phase="rpc_poll"} 1');
    expect(output).toContain('horizon_listener_duration_ms_sum{phase="rpc_poll"} 20');
  });

  it('DEFAULT_HISTOGRAM_BUCKETS is sorted ascending', () => {
    for (let i = 1; i < DEFAULT_HISTOGRAM_BUCKETS.length; i++) {
      expect(DEFAULT_HISTOGRAM_BUCKETS[i]).toBeGreaterThan(DEFAULT_HISTOGRAM_BUCKETS[i - 1]);
    }
  });
});

// ── NoopMetricsRegistry ───────────────────────────────────────────────────────

describe('NoopMetricsRegistry', () => {
  it('all counter gets return 0 and inc is a no-op', () => {
    const noop = new NoopMetricsRegistry();
    noop.counter.inc('rpc_poll', 'success');
    expect(noop.counter.get('rpc_poll', 'success')).toBe(0);
  });

  it('histogram observe is a no-op and snapshot returns zeros', () => {
    const noop = new NoopMetricsRegistry();
    noop.histogram.observe('webhook', 99);
    const snap = noop.histogram.snapshot('webhook');
    expect(snap.count).toBe(0);
    expect(snap.sum).toBe(0);
  });

  it('expose() returns an empty string', () => {
    const noop = new NoopMetricsRegistry();
    expect(noop.expose()).toBe('');
  });
});

// ── HorizonListener integration with metrics ──────────────────────────────────

describe('HorizonListener metrics integration', () => {
  it('records rpc_poll success and event_relay success for a normal poll cycle', async () => {
    const event = makeEvent({ id: 'evt-x' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'c1' })
      .mockResolvedValueOnce({ events: [], nextCursor: 'c2' });

    const eventSource: EventSource = { getEvents };
    const metrics = new MetricsRegistry();
    let stopAfterFirst = false;

    const listener = new HorizonListener({
      eventSource,
      onEvent: (_e) => {
        stopAfterFirst = true;
      },
      sleep: async () => {
        if (stopAfterFirst) listener.stop();
      },
      metrics,
    });

    await listener.start();

    expect(metrics.counter.get('rpc_poll', 'success')).toBeGreaterThanOrEqual(1);
    expect(metrics.counter.get('event_relay', 'success')).toBe(1);
    expect(metrics.counter.get('rpc_poll', 'failure')).toBe(0);
  });

  it('records rpc_poll failure when getEvents throws', async () => {
    const getEvents = jest
      .fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce({ events: [], nextCursor: 'c1' });

    const eventSource: EventSource = { getEvents };
    const metrics = new MetricsRegistry();
    let callCount = 0;

    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      // Stop after the second sleep (which runs after the first successful poll)
      sleep: async () => {
        callCount += 1;
        if (callCount >= 2) listener.stop();
      },
      metrics,
    });

    await listener.start();

    expect(metrics.counter.get('rpc_poll', 'failure')).toBe(1);
    expect(metrics.counter.get('rpc_poll', 'success')).toBeGreaterThanOrEqual(1);
  });

  it('records event_relay failure when onEvent throws', async () => {
    const event = makeEvent({ id: 'evt-bad' });
    const getEvents = jest
      .fn()
      .mockResolvedValueOnce({ events: [event], nextCursor: 'c1' })
      .mockResolvedValueOnce({ events: [], nextCursor: 'c2' });

    const eventSource: EventSource = { getEvents };
    const metrics = new MetricsRegistry();
    let didFail = false;

    const listener = new HorizonListener({
      eventSource,
      onEvent: (_e) => {
        didFail = true;
        throw new Error('handler error');
      },
      sleep: async () => {
        if (didFail) listener.stop();
      },
      metrics,
    });

    await listener.start();

    expect(metrics.counter.get('event_relay', 'failure')).toBe(1);
    expect(metrics.counter.get('event_relay', 'success')).toBe(0);
  });

  it('records rpc_poll cancelled when maxRetries is exhausted', async () => {
    const getEvents = jest.fn().mockRejectedValue(new Error('always down'));
    const eventSource: EventSource = { getEvents };
    const metrics = new MetricsRegistry();

    const listener = new HorizonListener({
      eventSource,
      onEvent: jest.fn(),
      maxRetries: 2,
      sleep: async () => {},
      metrics,
    });

    await expect(listener.start()).rejects.toThrow(/giving up/);

    expect(metrics.counter.get('rpc_poll', 'failure')).toBe(2);
    expect(metrics.counter.get('rpc_poll', 'cancelled')).toBe(1);
  });

  it('works correctly when no metrics registry is provided (no-op default)', async () => {
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
      // no metrics field — should use NoopMetricsRegistry silently
    });

    // Should resolve without errors and have no visible effect
    await expect(listener.start()).resolves.toBeUndefined();
  });
});

// ── HttpWebhookSender metrics integration ─────────────────────────────────────

describe('HttpWebhookSender metrics integration', () => {
  it('records webhook success on 2xx response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const metrics = new MetricsRegistry();
    const sender = new HttpWebhookSender({
      url: 'http://localhost:9999/webhook',
      fetchImpl,
      metrics,
    });

    await sender.send(makeEvent());

    expect(metrics.counter.get('webhook', 'success')).toBe(1);
    expect(metrics.counter.get('webhook', 'failure')).toBe(0);
    expect(metrics.histogram.snapshot('webhook').count).toBe(1);
  });

  it('records webhook failure on non-2xx response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 502 });
    const metrics = new MetricsRegistry();
    const sender = new HttpWebhookSender({
      url: 'http://localhost:9999/webhook',
      fetchImpl,
      metrics,
    });

    await expect(sender.send(makeEvent())).rejects.toThrow(/status 502/);

    expect(metrics.counter.get('webhook', 'failure')).toBe(1);
    expect(metrics.counter.get('webhook', 'success')).toBe(0);
    expect(metrics.histogram.snapshot('webhook').count).toBe(1);
  });

  it('records webhook failure when fetch itself throws (network error)', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const metrics = new MetricsRegistry();
    const sender = new HttpWebhookSender({
      url: 'http://localhost:9999/webhook',
      fetchImpl,
      metrics,
    });

    await expect(sender.send(makeEvent())).rejects.toThrow(/ECONNREFUSED/);

    expect(metrics.counter.get('webhook', 'failure')).toBe(1);
    expect(metrics.histogram.snapshot('webhook').count).toBe(1);
  });

  it('works without a metrics registry (no-op default)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const sender = new HttpWebhookSender({ url: 'http://localhost:9999/webhook', fetchImpl });
    // Should resolve without errors
    await expect(sender.send(makeEvent())).resolves.toBeUndefined();
  });
});
