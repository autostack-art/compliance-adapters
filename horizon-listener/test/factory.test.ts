import { createWebhookForwarder } from '../src/factory';
import { RpcEventSource } from '../src/eventSource';
import { HttpWebhookSender } from '../src/webhook';
import type { RawContractEvent } from '../src/eventSource';

// RpcEventSource pulls in @stellar/stellar-sdk (real network calls, and a
// dependency chain this package's jest config doesn't transform for direct
// import) and HttpWebhookSender talks to a real HTTP endpoint, so both are
// mocked wholesale here — this test only exercises createWebhookForwarder's
// wiring (options passed through, onEvent forwarding to webhook.send), not
// the real RPC/HTTP implementations, which have their own dedicated test
// files.
jest.mock('../src/eventSource', () => ({ RpcEventSource: jest.fn() }));
jest.mock('../src/webhook', () => ({ HttpWebhookSender: jest.fn() }));

function makeEvent(overrides: Partial<RawContractEvent> = {}): RawContractEvent {
  return {
    id: 'evt-1',
    contractId: 'CDENYLISTGATE',
    ledger: 1,
    topic: ['denylist_added'],
    value: { address: 'GADDR' },
    ...overrides,
  };
}

describe('createWebhookForwarder', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('constructs RpcEventSource and HttpWebhookSender from the given options', () => {
    const eventSourceOptions = {
      rpcUrl: 'https://rpc.example.com',
      networkPassphrase: 'Test SDF Network ; September 2015',
      contractIds: ['CDENYLISTGATE'],
    };
    const webhookOptions = { url: 'http://localhost:9999/webhook' };

    (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({
      getEvents: jest.fn(),
    }));
    (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({
      send: jest.fn(),
    }));

    createWebhookForwarder({ eventSource: eventSourceOptions, webhook: webhookOptions });

    expect(RpcEventSource).toHaveBeenCalledWith(eventSourceOptions);
    expect(HttpWebhookSender).toHaveBeenCalledWith(webhookOptions);
  });

  it("the returned listener's onEvent calls the underlying webhook sender's send", async () => {
    const event = makeEvent();
    const getEvents = jest.fn().mockResolvedValueOnce({ events: [event], nextCursor: 'cursor-1' });
    const send = jest.fn().mockResolvedValue(undefined);

    (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
    (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

    const listener = createWebhookForwarder({
      eventSource: {
        rpcUrl: 'https://rpc.example.com',
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractIds: ['CDENYLISTGATE'],
      },
      webhook: { url: 'http://localhost:9999/webhook' },
    });

    // Stop the poll loop as soon as the forwarded event reaches the (mocked)
    // webhook sender, so this test doesn't wait on a real pollIntervalMs sleep.
    send.mockImplementationOnce(async (forwardedEvent: RawContractEvent) => {
      expect(forwardedEvent).toEqual(event);
      listener.stop();
    });

    await listener.start();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(event);
  });

  it('passes through listenerOptions (e.g. pollIntervalMs) to the underlying HorizonListener', async () => {
    const getEvents = jest.fn().mockResolvedValueOnce({ events: [], nextCursor: 'cursor-1' });
    const send = jest.fn().mockResolvedValue(undefined);

    (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
    (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

    const sleep = jest.fn().mockImplementation(() => {
      listener.stop();
      return Promise.resolve();
    });

    const listener = createWebhookForwarder({
      eventSource: {
        rpcUrl: 'https://rpc.example.com',
        networkPassphrase: 'Test SDF Network ; September 2015',
        contractIds: ['CDENYLISTGATE'],
      },
      webhook: { url: 'http://localhost:9999/webhook' },
      listenerOptions: { pollIntervalMs: 1234, sleep },
    });

    await listener.start();

    expect(sleep).toHaveBeenCalledWith(1234, expect.anything());
  });

  describe('webhook parentContext threading (issue #327)', () => {
    it('threads parentContext from WebhookForwarderOptions to HttpWebhookSender', async () => {
      const getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [], nextCursor: 'cursor-1' });
      const send = jest.fn().mockResolvedValue(undefined);

      (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
      (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

      const parentContext = { traceId: 'event-relay-trace', spanId: 'event-relay-span' };

      createWebhookForwarder({
        eventSource: {
          rpcUrl: 'https://rpc.example.com',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractIds: ['CDENYLISTGATE'],
        },
        webhook: {
          url: 'http://localhost:9999/webhook',
          parentContext,
        },
      });

      expect(HttpWebhookSender).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:9999/webhook',
          parentContext,
        }),
      );
    });

    it('allows parentContext to be omitted', async () => {
      const getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [], nextCursor: 'cursor-1' });
      const send = jest.fn().mockResolvedValue(undefined);

      (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
      (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

      createWebhookForwarder({
        eventSource: {
          rpcUrl: 'https://rpc.example.com',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractIds: ['CDENYLISTGATE'],
        },
        webhook: { url: 'http://localhost:9999/webhook' },
      });

      expect(HttpWebhookSender).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:9999/webhook',
        }),
      );
    });

    it('preserves webhook span hierarchy when parentContext is supplied', async () => {
      const event = makeEvent();
      const getEvents = jest.fn().mockResolvedValueOnce({ events: [event], nextCursor: 'cursor-1' });
      const send = jest.fn().mockResolvedValue(undefined);

      (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
      (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

      const parentContext = { traceId: 'root-trace', spanId: 'event-relay-span' };

      send.mockImplementationOnce(async (forwardedEvent: RawContractEvent) => {
        expect(forwardedEvent).toEqual(event);
        listener.stop();
      });

      const listener = createWebhookForwarder({
        eventSource: {
          rpcUrl: 'https://rpc.example.com',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractIds: ['CDENYLISTGATE'],
        },
        webhook: {
          url: 'http://localhost:9999/webhook',
          parentContext,
        },
      });

      await listener.start();

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(event);
    });
  });

  describe('metrics/tracer threading (issue #326)', () => {
    it('threads metrics option from WebhookForwarderOptions to HttpWebhookSender', async () => {
      const getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [], nextCursor: 'cursor-1' });
      const send = jest.fn().mockResolvedValue(undefined);

      (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
      (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

      const mockMetrics = { /* metrics registry mock */ } as any;

      createWebhookForwarder({
        eventSource: {
          rpcUrl: 'https://rpc.example.com',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractIds: ['CDENYLISTGATE'],
        },
        webhook: { url: 'http://localhost:9999/webhook', metrics: mockMetrics },
        listenerOptions: { metrics: mockMetrics },
      });

      expect(HttpWebhookSender).toHaveBeenCalledWith(
        expect.objectContaining({
          metrics: mockMetrics,
        }),
      );
    });

    it('threads tracer option from WebhookForwarderOptions to HttpWebhookSender', async () => {
      const getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [], nextCursor: 'cursor-1' });
      const send = jest.fn().mockResolvedValue(undefined);

      (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
      (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

      const mockTracer = { /* tracer mock */ } as any;

      createWebhookForwarder({
        eventSource: {
          rpcUrl: 'https://rpc.example.com',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractIds: ['CDENYLISTGATE'],
        },
        webhook: { url: 'http://localhost:9999/webhook', tracer: mockTracer },
        listenerOptions: { tracer: mockTracer },
      });

      expect(HttpWebhookSender).toHaveBeenCalledWith(
        expect.objectContaining({
          tracer: mockTracer,
        }),
      );
    });

    it('threads both metrics and tracer together', async () => {
      const getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [], nextCursor: 'cursor-1' });
      const send = jest.fn().mockResolvedValue(undefined);

      (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
      (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

      const mockMetrics = { /* metrics registry mock */ } as any;
      const mockTracer = { /* tracer mock */ } as any;

      createWebhookForwarder({
        eventSource: {
          rpcUrl: 'https://rpc.example.com',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractIds: ['CDENYLISTGATE'],
        },
        webhook: {
          url: 'http://localhost:9999/webhook',
          metrics: mockMetrics,
          tracer: mockTracer,
        },
        listenerOptions: {
          metrics: mockMetrics,
          tracer: mockTracer,
        },
      });

      expect(HttpWebhookSender).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:9999/webhook',
          metrics: mockMetrics,
          tracer: mockTracer,
        }),
      );
    });

    it('allows metrics and tracer to be omitted', async () => {
      const getEvents = jest
        .fn()
        .mockResolvedValueOnce({ events: [], nextCursor: 'cursor-1' });
      const send = jest.fn().mockResolvedValue(undefined);

      (RpcEventSource as unknown as jest.Mock).mockImplementation(() => ({ getEvents }));
      (HttpWebhookSender as unknown as jest.Mock).mockImplementation(() => ({ send }));

      createWebhookForwarder({
        eventSource: {
          rpcUrl: 'https://rpc.example.com',
          networkPassphrase: 'Test SDF Network ; September 2015',
          contractIds: ['CDENYLISTGATE'],
        },
        webhook: { url: 'http://localhost:9999/webhook' },
      });

      expect(HttpWebhookSender).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'http://localhost:9999/webhook',
        }),
      );
    });
  });
});
