/**
 * Metric normalization.
 *
 * Providers report what the hardware says. Normalization turns that into the
 * canonical vocabulary: it rejects impossible values, converts units, and — most
 * importantly — *omits* anything it cannot stand behind. A rejected reading is
 * reported as a violation so a broken provider is visible instead of silently
 * feeding zeros into the pressure model.
 *
 * @module dsh-health-scheduler/core/normalize
 */

import { metricDescriptor, type CanonicalMetric, type MetricBag } from '../types/index.js'
import type { HealthSample } from '../types/provider.js'

/** One rejected reading. */
export interface NormalizationViolation {
  /** Provider the reading came from. */
  readonly provider: string
  /** Metric name, or the raw key when the name itself was not canonical. */
  readonly metric: string
  /** Why the reading was rejected. */
  readonly reason:
    | 'not_canonical'
    | 'not_a_number'
    | 'not_finite'
    | 'below_hard_min'
    | 'above_hard_max'
    | 'clamped'
  /** The offending raw value. */
  readonly value: unknown
  /** Human-readable explanation. */
  readonly detail: string
}

/** Result of normalizing one sample. */
export interface NormalizationResult {
  /** Canonical metrics that survived, in canonical name order. */
  readonly metrics: MetricBag
  /** Everything that was rejected or clamped. */
  readonly violations: readonly NormalizationViolation[]
}

/**
 * Coerce one raw reading to a canonical value.
 *
 * Returns a number, `null` for "omit", or throws nothing: every failure mode is
 * a violation entry rather than an exception, because one bad sensor must not
 * take down a tick.
 */
function normalizeValue(
  provider: string,
  metric: CanonicalMetric,
  raw: unknown,
  violations: NormalizationViolation[],
): number | null {
  const descriptor = metricDescriptor(metric)
  if (descriptor === undefined) {
    violations.push({
      provider,
      metric,
      reason: 'not_canonical',
      value: raw,
      detail: 'metric is not in the canonical registry',
    })
    return null
  }
  if (typeof raw !== 'number') {
    violations.push({
      provider,
      metric,
      reason: 'not_a_number',
      value: raw,
      detail: `expected a number, received ${typeof raw}`,
    })
    return null
  }
  if (!Number.isFinite(raw)) {
    violations.push({
      provider,
      metric,
      reason: 'not_finite',
      value: raw,
      detail: 'NaN and Infinity are not measurements',
    })
    return null
  }

  let value = raw

  // A ratio sent as a percentage is the single most common provider mistake, so
  // it is repaired with a violation rather than rejected as out of range.
  if (descriptor.unit === 'ratio' && value > 1 && value <= 1.5) {
    violations.push({
      provider,
      metric,
      reason: 'clamped',
      value,
      detail: 'ratio above 1.0 clamped to 1.0 (did the provider report a percentage?)',
    })
    value = 1
  }

  if (descriptor.hardMin !== undefined && value < descriptor.hardMin) {
    if (value < descriptor.hardMin - 1e-9 * Math.max(1, Math.abs(descriptor.hardMin))) {
      violations.push({
        provider,
        metric,
        reason: 'below_hard_min',
        value,
        detail: `${value} is below the physical minimum ${descriptor.hardMin}`,
      })
      return null
    }
    value = descriptor.hardMin
  }
  if (descriptor.hardMax !== undefined && value > descriptor.hardMax) {
    if (value > descriptor.hardMax + 1e-9 * Math.max(1, Math.abs(descriptor.hardMax))) {
      violations.push({
        provider,
        metric,
        reason: 'above_hard_max',
        value,
        detail: `${value} is above the physical maximum ${descriptor.hardMax}`,
      })
      return null
    }
    value = descriptor.hardMax
  }

  return value
}

/**
 * Normalize one provider sample.
 *
 * @param sample - the raw sample.
 * @returns canonical metrics and the violations that produced them.
 */
export function normalizeSample(sample: HealthSample): NormalizationResult {
  const violations: NormalizationViolation[] = []
  const entries: Array<readonly [CanonicalMetric, number]> = []

  for (const [key, raw] of Object.entries(sample.metrics ?? {})) {
    const value = normalizeValue(sample.provider, key as CanonicalMetric, raw, violations)
    if (value !== null) entries.push([key as CanonicalMetric, value])
  }

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const metrics: MetricBag = {}
  for (const [metric, value] of entries) {
    ;(metrics as Record<string, number>)[metric] = value
  }
  return { metrics, violations }
}

/** Parse an ISO-8601 timestamp into epoch milliseconds, or `null`. */
export function parseSampleTime(timestamp: string): number | null {
  const ms = Date.parse(timestamp)
  return Number.isFinite(ms) ? ms : null
}
