/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { computeBackoffDelayMs } from '@compliance-adapters/backoff';
import type { RawContractEvent } from './eventSource';
import { type AnyMetricsRegistry, NoopMetricsRegistry } from './metrics';
import { type AnyTracer, NoopTracer, type TracingContext } from './tracing';

/**
 * Version of the webhook payload shape. Sent as the
 * `X-Compliance-Schema-Version` header and the `schemaVersion` body field.
 * Bumped only on breaking payload changes; see the README versioning policy.
 */
export const WEBHOOK_SCHEMA_VERSION = 1;

export interface WebhookSender {
  send(event: RawContractEvent): Promise<void>;
}

/**
 * Thrown when the webhook endpoint responds with a non-OK HTTP status.
 * Carries the status code so callers (and the retry loop below) can tell a
 * permanent client error (4xx) apart from a transient server error (5xx).
 *
 * @example
 * ```ts
 * import { HttpWebhookSender, WebhookHttpError } from 'horizon-listener';
 *
 * try {
 *   await sender.send(event);
 * } catch (err) {
 *   if (err instanceof WebhookHttpError) {
 *     console.error('webhook returned HTTP', err.status);
 *   }
 * }
 * ```
 */
export class WebhookHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'WebhookHttpError';
  }
}

export interface HttpWebhookSenderOptions {
  url: string;
  /**
   * Shared secret used to sign outbound requests. When set, every request
   * carries an `X-Timestamp` header (Unix seconds) and an `X-Signature`
   * header (`sha256=<hex hmac>`) computed over `<timestamp>.<raw body>` so
   * receivers can verify the request came from this sender *and* reject
   * stale/replayed deliveries by enforcing a freshness window on the
   * timestamp. See horizon-listener/README.md for the verification recipe.
   *
   * Pass an array to rotate secrets without downtime: the first entry is the
   * primary, and one comma-separated signature is sent per secret
   * (`sha256=<a>,sha256=<b>`) so receivers on either secret keep verifying.
   */
  signingSecret?: string | string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Maximum retry attempts (with exponential backoff) for transient
   * failures: 5xx responses and network errors. A 4xx response is treated
   * as a permanent client error (bad config, auth, etc.) and is never
   * retried, regardless of this setting. Defaults to 3.
   */
  maxRetries?: number;
  /**
   * Optional metrics registry.  Pass a `MetricsRegistry` instance to record
   * per-call counters and latency histograms for the `webhook` phase.
   * Defaults to a no-op registry — zero overhead when omitted.
   */
  metrics?: AnyMetricsRegistry;
  /**
   * Optional tracer for OpenTelemetry-compatible distributed tracing.
   * When omitted, a no-op tracer is used — zero overhead and no exports.
   *
   * Pass a parent `TracingContext` alongside the tracer to nest webhook spans
   * inside an existing trace tree (e.g. a parent `event_relay` span).
   */
  tracer?: AnyTracer;
  /** Parent context for outbound webhook spans. */
  parentContext?: TracingContext;
  /**
   * Opt-in batching. When greater than 1, events are buffered and POSTed as
   * `{ events: [...] }` once `batchSize` events are queued or `batchMaxWaitMs`
   * elapses, whichever comes first. The signature covers the whole body and
   * the batch is retried as a unit. Defaults to 1 (one event per request).
   */
  batchSize?: number;
  /** Maximum time (ms) an event waits in a partial batch. Defaults to 1000. */
  batchMaxWaitMs?: number;
}

/**
 * Verifies an `X-Signature` header produced by {@link HttpWebhookSender}
 * against one or more secrets. Returns true when any signature in the header
 * matches any secret, so receivers can accept both old and new secrets
 * during a rotation window. Does not check timestamp freshness.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  timestamp: string,
  signatureHeader: string,
  secrets: string | string[],
): boolean {
  const provided = signatureHeader.split(',').map((s) => Buffer.from(s.trim()));
  const material = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(rawBody)]);
  return (Array.isArray(secrets) ? secrets : [secrets]).some((secret) => {
    const expected = Buffer.from(
      `sha256=${createHmac('sha256', secret).update(material).digest('hex')}`,
    );
    return provided.some((p) => p.length === expected.length && timingSafeEqual(p, expected));
  });
}

interface PendingDelivery {
  event: RawContractEvent;
  resolve: () => void;
  reject: (err: Error) => void;
}

export class HttpWebhookSender implements WebhookSender {
  private readonly url: string;
  private readonly signingSecrets: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number | undefined;
  private readonly maxRetries: number;
  private readonly metrics: AnyMetricsRegistry;
  private readonly tracer: AnyTracer;
  private readonly parentContext: TracingContext | undefined;
  private readonly batchSize: number;
  private readonly batchMaxWaitMs: number;
  private buffer: PendingDelivery[] = [];
  private batchTimer: NodeJS.Timeout | undefined;

  constructor(options: HttpWebhookSenderOptions) {
    // Validate URL is syntactically valid and has a protocol (http/https)
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.url);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `horizon-listener: HttpWebhookSender invalid URL "${options.url}" (${reason})`,
      );
    }

    // Ensure URL has a protocol (http or https) to catch typos like "localhost:3000"
    if (!parsedUrl.protocol.startsWith('http')) {
      throw new Error(
        `horizon-listener: HttpWebhookSender invalid URL "${options.url}" (must start with http:// or https://)`,
      );
    }

    this.url = options.url;
    const secrets = options.signingSecret;
    this.signingSecrets = (Array.isArray(secrets) ? secrets : secrets ? [secrets] : []).filter(
      Boolean,
    );
    // Node 20+ ships a global fetch; fetchImpl is injectable so tests never
    // make a real network call.
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries ?? 3;
    this.metrics = options.metrics ?? new NoopMetricsRegistry();
    this.tracer = options.tracer ?? new NoopTracer();
    this.parentContext = options.parentContext;
    this.batchSize = Math.max(1, options.batchSize ?? 1);
    this.batchMaxWaitMs = options.batchMaxWaitMs ?? 1000;
  }

  /**
   * Sends an event to the configured webhook URL.
   * @throws {Error} When the HTTP response is not OK (status >= 400).
   * Consumers should handle this error with retry logic or fallback behavior.
   */
  async send(event: RawContractEvent): Promise<void> {
    if (this.batchSize <= 1) {
      return this.deliver(JSON.stringify({ event }), event.id, [event.id]);
    }
    return new Promise<void>((resolve, reject) => {
      this.buffer.push({ event, resolve, reject });
      if (this.buffer.length >= this.batchSize) {
        void this.flush();
      } else if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => void this.flush(), this.batchMaxWaitMs);
      }
    });
  }

  /**
   * Delivers any partially-filled batch immediately. Call on shutdown so
   * buffered events are not lost. No-op when batching is disabled.
   */
  async flush(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    const pending = this.buffer;
    this.buffer = [];
    if (pending.length === 0) return;
    const events = pending.map((p) => p.event);
    const ids = events.map((e) => e.id);
    // Stable across retries of the same batch, so receivers can deduplicate.
    const idempotencyKey = createHmac('sha256', 'batch').update(ids.join(',')).digest('hex');
    try {
      await this.deliver(JSON.stringify({ events }), idempotencyKey, ids);
      pending.forEach((p) => p.resolve());
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      pending.forEach((p) => p.reject(error));
    }
  }

  /** Flushes any partial batch. Alias for {@link flush} for shutdown hooks. */
  stop(): Promise<void> {
    return this.flush();
  }

  private async deliver(body: string, idempotencyKey: string, eventIds: string[]): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Derived from the event id, so identical across retries of one event.
      'Idempotency-Key': idempotencyKey,
    };

    if (this.signingSecrets.length > 0) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      headers['X-Timestamp'] = timestamp;
      headers['X-Signature'] = this.signingSecrets
        .map((secret) => `sha256=${this.sign(secret, timestamp, body)}`)
        .join(',');
    }

    // The span covers the entire logical delivery (including retries), so it
    // is started once here and ended exactly once below on final success or
    // final failure — not per attempt.
    const span = this.tracer.startSpan('webhook', this.parentContext);
    span.setAttribute('webhook.url', this.url);
    // event.id is a stable, low-cardinality correlation identifier — safe to attach
    span.setAttribute('event.id', eventIds.join(','));
    if (eventIds.length > 1) span.setAttribute('webhook.batch_size', eventIds.length);

    // Inject W3C traceparent for downstream correlation (disable via propagateTraceContext: false).
    const traceparent =
      this.propagateTraceContext && span.traceId
        ? this.tracer.injectContext({ traceId: span.traceId, spanId: span.spanId })
        : undefined;
    if (traceparent) {
      headers['traceparent'] = traceparent;
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const delayMs = computeBackoffDelayMs(attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const start = Date.now();
      try {
        const controller = this.timeoutMs ? new AbortController() : undefined;
        let timeoutHandle: NodeJS.Timeout | undefined;

        try {
          if (controller && this.timeoutMs) {
            timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
          }

          const response = await this.fetchImpl(this.url, {
            method: 'POST',
            headers,
            body,
            signal: controller?.signal,
            ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
          } as RequestInit);

          const durationMs = Date.now() - start;

          if (!response.ok) {
            const errorBody = await readErrorBody(response);
            throw new WebhookHttpError(
              `horizon-listener: webhook POST to ${this.url} failed with status ${response.status}` +
                (errorBody ? `: ${errorBody}` : ''),
              response.status,
            );
          }

          this.metrics.counter.inc('webhook', 'success');
          this.metrics.histogram.observe('webhook', durationMs);
          span.setAttribute('http.status_code', response.status);
          span.end('ok');
          return;
        } finally {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        }
      } catch (error) {
        const httpError = error instanceof WebhookHttpError ? error : undefined;
        const durationMs = Date.now() - start;
        this.metrics.counter.inc('webhook', 'failure');
        this.metrics.histogram.observe('webhook', durationMs);
        lastError = error instanceof Error ? error : new Error(String(error));

        // 4xx responses are permanent client errors (bad config, auth, etc.)
        // that will never succeed on retry, so fail fast instead of burning
        // the retry budget. 5xx responses and network errors are treated as
        // transient and keep retrying up to maxRetries.
        const isPermanentClientError =
          httpError !== undefined && httpError.status >= 400 && httpError.status < 500;
        if (isPermanentClientError || attempt === this.maxRetries) {
          span.end('error', lastError);
          throw lastError;
        }
      }
    }
  }

  private sign(secret: string, timestamp: string, body: string): string {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  }
}
