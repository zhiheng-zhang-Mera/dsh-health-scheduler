/**
 * Rolling-window and trend types.
 *
 * A single sample is never enough to justify a high-risk action, so every metric
 * is kept as a time series and every decision reads statistics rather than
 * points. The store keeps raw samples for the short horizon and coarse
 * aggregates for the long horizon, which is all this plugin needs to answer
 * "is the machine getting worse?" without becoming an observability platform.
 *
 * @module dsh-health-scheduler/types/window
 */

import type { CanonicalMetric } from './metrics.js'

/** Statistics of one metric over one window. */
export interface WindowStats {
  /** Metric name. */
  readonly metric: CanonicalMetric
  /** Window length in milliseconds. */
  readonly windowMs: number
  /** Number of samples inside the window. */
  readonly count: number
  /** Arithmetic mean, or `null` when empty. */
  readonly mean: number | null
  /** Median, or `null` when empty. */
  readonly median: number | null
  /** 95th percentile, or `null` when empty. */
  readonly p95: number | null
  /** Maximum, or `null` when empty. */
  readonly max: number | null
  /** Minimum, or `null` when empty. */
  readonly min: number | null
  /** Most recent value in the window, or `null` when empty. */
  readonly latest: number | null
  /** Oldest value in the window, or `null` when empty. */
  readonly earliest: number | null
  /** Absolute change between the oldest and newest value, or `null`. */
  readonly changeRate: number | null
  /** Fractional change `(latest - earliest) / |earliest|`, or `null`. */
  readonly changeFraction: number | null
  /** Least-squares slope in units per hour, or `null` when not computable. */
  readonly slopePerHour: number | null
  /** Coefficient of determination of the slope fit, 0..1, or `null`. */
  readonly rSquared: number | null
  /**
   * Milliseconds the metric has continuously been at or above the last
   * configured threshold, or `0` when it currently is not.
   */
  readonly consecutiveMs: number
  /** Total observation span inside the window, in milliseconds. */
  readonly spanMs: number
}

/** One aggregated bucket for the long horizon. */
export interface AggregatedBucket {
  /** Bucket start instant, epoch milliseconds, aligned to the bucket size. */
  readonly startMs: number
  /** Bucket size in milliseconds. */
  readonly bucketMs: number
  /** Sample count in the bucket. */
  readonly count: number
  /** Mean value in the bucket. */
  readonly mean: number
  /** Maximum value in the bucket. */
  readonly max: number
  /** Minimum value in the bucket. */
  readonly min: number
}

/** The trend verdict for one metric. */
export type TrendDirection = 'rising' | 'falling' | 'flat' | 'unknown'

/** A trusted trend for one metric. */
export interface MetricTrend {
  /** Metric name. */
  readonly metric: CanonicalMetric
  /** Direction over the evaluation horizon. */
  readonly direction: TrendDirection
  /** Slope in metric units per hour, or `null` when not computable. */
  readonly slopePerHour: number | null
  /** Goodness of fit, 0..1, or `null`. */
  readonly rSquared: number | null
  /** Observation span the slope was fitted over, in milliseconds. */
  readonly spanMs: number
  /** Sample count the slope was fitted over. */
  readonly count: number
  /**
   * Whether the trend passed every configured gate (sample count, span, R²)
   * and has the polarity that raises pressure.
   */
  readonly isWorsening: boolean
  /** Human-readable explanation, e.g. `+412 MB/h (R²=0.93, 42 min)`. */
  readonly summary: string
}

/** How fast a metric is growing, already expressed in the metric's own unit. */
export interface GrowthProjection {
  /** Metric name. */
  readonly metric: CanonicalMetric
  /** Slope in units per hour, or `null`. */
  readonly perHour: number | null
  /** Slope in units per day, or `null`. */
  readonly perDay: number | null
  /**
   * Projected milliseconds until the metric reaches the given ceiling, or
   * `null` when it is not rising or already past it.
   */
  readonly msToCeiling: number | null
}
