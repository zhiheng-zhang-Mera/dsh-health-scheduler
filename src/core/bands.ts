/**
 * Band arithmetic.
 *
 * One metric, one band, one 0..100 number. The ramp is linear between `warn`
 * (0 points) and `critical` (100 points) with a gentle tail beyond `critical` so
 * a machine that is far past the limit reads clearly worse than one just over it.
 * Polarity decides which end of the band is bad, which is why a recovered
 * `recovery_rate` and a saturated `ram_used_ratio` can share one implementation.
 *
 * @module dsh-health-scheduler/core/bands
 */

import { metricDescriptor, type CanonicalMetric, type MetricPolarity } from '../types/index.js'
import type { MetricBand } from '../types/config.js'
import type { PressureLevel } from '../types/decision.js'

/** Score boundaries between pressure levels. */
export const LEVEL_BOUNDS = Object.freeze({
  /** Scores above this are at least `low`. */
  low: 0,
  /** Scores at or above this are `moderate`. */
  moderate: 35,
  /** Scores at or above this are `high`. */
  high: 65,
  /** Scores at or above this are `critical`. */
  critical: 85,
})

/** Map a 0..100 score onto its level. `null` maps to `unknown`. */
export function levelOf(score: number | null): PressureLevel {
  if (score === null || !Number.isFinite(score)) return 'unknown'
  if (score <= LEVEL_BOUNDS.low) return 'none'
  if (score < LEVEL_BOUNDS.moderate) return 'low'
  if (score < LEVEL_BOUNDS.high) return 'moderate'
  if (score < LEVEL_BOUNDS.critical) return 'high'
  return 'critical'
}

/** Clamp a number into a range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Order two tuples by descending score, treating `null` as the lowest. */
export function byScoreDescending<T extends { score: number | null }>(a: T, b: T): number {
  return (b.score ?? -1) - (a.score ?? -1)
}

/**
 * The `[best, worst]` ramp endpoints for a metric, in that order.
 *
 * Polarity decides the mapping, and it is the metric registry — not the numbers —
 * that owns polarity. For a higher-is-worse metric `warn` is the good end, so a
 * band of `{warn: 0.8, critical: 0.96}` ramps 0.8 -> 0.96. For a lower-is-worse
 * metric `warn` is still the good end, so `{warn: 0.8, critical: 0.3}` ramps
 * 0.8 -> 0.3 and reads correctly without the author having to remember an
 * ordering convention. Writing either band with its numbers swapped is accepted
 * and normalized to the same ramp.
 *
 * A malformed band (warn equal to critical) is rejected by config validation
 * long before this point.
 */
export function rampEndpoints(band: MetricBand, polarity: MetricPolarity = 'higher-is-worse'): readonly [number, number] {
  const lo = Math.min(band.warn, band.critical)
  const hi = Math.max(band.warn, band.critical)
  return polarity === 'lower-is-worse' ? [hi, lo] : [lo, hi]
}

/**
 * Which band a value currently sits in, as a stable identity string.
 *
 * Band identity is what the sustain gate measures duration against, so it must be
 * derived from the value and the band the same way every time. `atOrPastCritical`
 * respects polarity: for a lower-is-worse metric, "critical" is the *lower*
 * endpoint.
 *
 * @param metric - canonical metric name.
 * @param value - normalized value.
 * @param band - the metric's warn/critical endpoints, in either order.
 * @param polarity - which direction is worse; taken from the registry when omitted.
 * @returns a stable band key, or `null` when the value is inside no band.
 */
export function bandKeyOf(
  metric: CanonicalMetric,
  value: number,
  band: MetricBand,
  polarity: MetricPolarity = metricDescriptor(metric)?.polarity ?? 'higher-is-worse',
): string | null {
  const [best, worst] = rampEndpoints(band, polarity)
  if (polarity === 'lower-is-worse') {
    if (value <= best) return `${metric}:critical`
    if (value <= worst) return `${metric}:warn`
    return null
  }
  if (value >= worst) return `${metric}:critical`
  if (value >= best) return `${metric}:warn`
  return null
}

/**
 * Score one metric value against its band.
 *
 * @param metric - canonical metric name, used only for diagnostics.
 * @param value - normalized value, or `null` when unknown.
 * @param band - the metric's warn/critical endpoints, in either order.
 * @param polarity - which direction is worse; taken from the registry when omitted.
 * @returns a score in `[0, 100]`, or `null` when the value is unknown.
 */
export function scoreMetric(
  metric: CanonicalMetric,
  value: number | null,
  band: MetricBand,
  polarity: MetricPolarity = metricDescriptor(metric)?.polarity ?? 'higher-is-worse',
): number | null {
  if (value === null || !Number.isFinite(value)) return null
  const [best, worst] = rampEndpoints(band, polarity)
  const span = worst - best
  if (span === 0) return value === best ? 0 : 100

  const progress = (value - best) / span
  if (progress <= 0) return 0
  if (progress >= 1) return 100
  return Math.round(progress * 100)
}

/**
 * Score one metric value against its band, then decide whether the score is
 * allowed to count yet.
 *
 * The sustain gate is the difference between "GPU is at 90 °C" and "GPU has been
 * at 90 °C for 15 minutes". A transient spike scores 0 rather than scoring high
 * and being filtered later, so the number that reaches the policy engine is
 * always a number the plugin is willing to defend.
 *
 * @param metric - canonical metric name.
 * @param value - normalized value, or `null`.
 * @param band - ramp endpoints.
 * @param sustainMs - consecutive milliseconds the band must be held.
 * @param heldMs - how long the metric has actually held its current band.
 * @returns the gated score (`0` while the gate is unmet) plus the raw score.
 */
export function scoreWithSustain(
  metric: CanonicalMetric,
  value: number | null,
  band: MetricBand,
  sustainMs: number,
  heldMs: number,
): { readonly score: number | null; readonly rawScore: number | null; readonly sustainedMs: number; readonly gated: boolean } {
  const rawScore = scoreMetric(metric, value, band)
  if (rawScore === null) return { score: null, rawScore: null, sustainedMs: 0, gated: false }
  if (sustainMs <= 0) return { score: rawScore, rawScore, sustainedMs: heldMs, gated: false }
  if (heldMs >= sustainMs) return { score: rawScore, rawScore, sustainedMs: heldMs, gated: false }
  return { score: 0, rawScore, sustainedMs: heldMs, gated: true }
}

/** Human-readable rule text for a metric score. */
export function describeRule(
  metric: CanonicalMetric,
  band: MetricBand,
  sustainMs: number,
  heldMs: number,
): string {
  const descriptor = metricDescriptor(metric)
  const unit = descriptor?.unit ?? 'value'
  const comparison = descriptor?.polarity === 'lower-is-worse' ? '<=' : '>='
  const sustained = sustainMs > 0 ? ` for ${Math.round(sustainMs / 1000)}s` : ''
  const held = heldMs > 0 ? ` (held ${Math.round(heldMs / 1000)}s)` : ''
  return `${metric} ${comparison} ${band.warn} ${unit}${sustained}${held}`
}
