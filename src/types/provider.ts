/**
 * Provider contract of `dsh-health-scheduler`.
 *
 * All health data enters the plugin through a provider. Nothing downstream —
 * normalization included — is allowed to reach for NVML, LibreHardwareMonitor,
 * HWiNFO, a Windows API, worker internals, or Electron internals. A provider is
 * the only module that knows how to talk to one telemetry source, and the only
 * thing it must be able to do is produce a {@link HealthSample}.
 *
 * @module dsh-health-scheduler/types/provider
 */

import type { CanonicalMetric, MetricBag } from './metrics.js'

export type { MetricBag, MetricReading } from './metrics.js'

/** Why a sample carries partial or no data. */
export type DegradedReason =
  | 'telemetry_unavailable'
  | 'permission_denied'
  | 'timeout'
  | 'platform_unsupported'
  | 'provider_disabled'

/**
 * One sample from one provider.
 *
 * `metrics` carries only what was actually measured: a provider that cannot read
 * a sensor omits the key rather than reporting `0`, and the pressure model scores
 * that absence as `unknown`.
 */
export interface HealthSample {
  /** Provider id, matching {@link HealthProvider.id}. */
  readonly provider: string
  /** Wall-clock instant the sample was taken, ISO-8601 with offset. */
  readonly timestamp: string
  /** Canonical metrics that were actually measured. */
  readonly metrics: MetricBag
  /**
   * True when the provider ran but could not measure everything it normally
   * would. The metrics it did measure stay authoritative.
   */
  readonly degraded?: boolean
  /** Machine-readable explanation for {@link HealthSample.degraded}. */
  readonly degradedReason?: DegradedReason
  /** Free-form provider detail; never used for scoring. */
  readonly note?: string
}

/**
 * What every health provider must implement.
 *
 * `sample()` is called on the scheduler tick and must be cheap and
 * non-blocking: it reports a measurement, it does not perform one. Providers
 * that need an asynchronous probe are expected to keep a cached value that a
 * background probe refreshes, and to return that cache.
 *
 * `sample()` may reject. A rejection disables only this provider, for a bounded
 * backoff window, and the scheduler continues with every other provider.
 */
export interface HealthProvider {
  /** Stable unique id, lowercase kebab-case. */
  readonly id: string
  /** Subsystem the provider reports on; used for grouping in the UI payload. */
  readonly group: ProviderGroup
  /** Canonical metrics this provider may report. Used to size the unknown share. */
  readonly provides: readonly CanonicalMetric[]
  /** Whether the provider is currently expected to produce data. */
  readonly enabled?: boolean
  /** Collect one sample. Must not throw for mere data absence — omit the metric. */
  sample(): Promise<HealthSample> | HealthSample
}

/** Provider grouping, mirroring {@link MetricGroup} plus the integration seams. */
export type ProviderGroup =
  | 'hardware'
  | 'memory'
  | 'runtime'
  | 'workers'
  | 'computer-use'
  | 'ui'
  | 'context'

/** Runtime health of one provider, tracked by {@link ProviderRegistry}. */
export interface ProviderStatus {
  /** Provider id. */
  readonly id: string
  /** Provider group. */
  readonly group: ProviderGroup
  /** Consecutive failures since the last success. */
  readonly consecutiveFailures: number
  /** Total failures observed since the scheduler started. */
  readonly totalFailures: number
  /** Total successful samples since the scheduler started. */
  readonly totalSuccesses: number
  /** ISO-8601 instant of the last successful sample, or `null`. */
  readonly lastSuccessAt: string | null
  /** ISO-8601 instant of the last failure, or `null`. */
  readonly lastFailureAt: string | null
  /** Last error message, or `null`. */
  readonly lastError: string | null
  /** Remaining disabled milliseconds from the circuit breaker, or `0`. */
  readonly backoffRemainingMs: number
  /** Whether the provider will be sampled on the next tick. */
  readonly available: boolean
}

/** One provider failure, emitted as an audit event. */
export interface ProviderFailure {
  /** Provider id. */
  readonly provider: string
  /** Error message, already stringified and truncated. */
  readonly message: string
  /** Consecutive failure count after this failure. */
  readonly consecutiveFailures: number
  /** Backoff applied to the provider, in milliseconds. */
  readonly backoffMs: number
  /** ISO-8601 instant of the failure. */
  readonly timestamp: string
}
