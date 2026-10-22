/**
 * Copyright (c) 2026 stellar-compliance-kit
 * SPDX-License-Identifier: MIT
 */

/**
 * sanctions-oracle's phase-specific binding of the generic
 * `@compliance-adapters/metrics` registry (shared with horizon-listener).
 *
 * Phases tracked
 * ──────────────
 * address_check   — each call to `provider.checkAddress()` (sanctions lookup)
 * denylist_write  — each call to `writer.addToDenylist()` (on-chain write)
 */

import {
  MetricsRegistry as GenericMetricsRegistry,
  NoopMetricsRegistry as GenericNoopMetricsRegistry,
  DEFAULT_HISTOGRAM_BUCKETS,
  type Counter,
  type Histogram,
  type Outcome,
  type MetricsRegistryOptions as GenericMetricsRegistryOptions,
} from '@compliance-adapters/metrics';

export { DEFAULT_HISTOGRAM_BUCKETS };
export type { Counter, Histogram, Outcome };

export type SanctionsPhase = 'address_check' | 'denylist_write';

const PHASES: SanctionsPhase[] = ['address_check', 'denylist_write'];

export type MetricsRegistryOptions = Omit<
  GenericMetricsRegistryOptions<SanctionsPhase>,
  'phases' | 'prefix'
> & {
  /** Prefix prepended to every metric name (default: `sanctions_oracle`). */
  prefix?: string;
};

/**
 * Holds a counter and a histogram for sanctions-oracle phases.
 *
 * Pass an instance to `SyncOptions.metrics` to enable recording.  Omit it to
 * use the built-in no-op registry — there is zero overhead.
 */
export class MetricsRegistry extends GenericMetricsRegistry<SanctionsPhase> {
  constructor(options: MetricsRegistryOptions = {}) {
    super({ ...options, prefix: options.prefix ?? 'sanctions_oracle', phases: PHASES });
  }
}

/**
 * A no-op registry that discards all observations.
 * Used as the default so callers that don't provide a registry pay no cost.
 */
export class NoopMetricsRegistry extends GenericNoopMetricsRegistry<SanctionsPhase> {}

export type AnyMetricsRegistry = MetricsRegistry | NoopMetricsRegistry;
