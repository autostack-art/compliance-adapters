/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

import { SpanData, SpanStatus, TracingContext } from '../src';

describe('tracing-types shape compatibility', () => {
  it('constructs a SpanData literal with all required fields', () => {
    const status: SpanStatus = 'ok';
    const span: SpanData = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      parentSpanId: undefined,
      name: 'oracle.fetch',
      startTimeMs: 1000,
      endTimeMs: 1100,
      durationMs: 100,
      status,
      attributes: {
        provider: 'mock',
        attempt: 1,
        cached: false,
      },
    };

    expect(span.traceId).toHaveLength(32);
    expect(span.spanId).toHaveLength(16);
    expect(span.status).toBe('ok');
    expect(span.durationMs).toBe(span.endTimeMs - span.startTimeMs);
  });

  it('constructs a TracingContext literal with required fields', () => {
    const context: TracingContext = {
      traceId: 'fedcba9876543210fedcba9876543210',
      spanId: 'fedcba9876543210',
    };

    expect(context.traceId).toHaveLength(32);
    expect(context.spanId).toHaveLength(16);
  });
});
