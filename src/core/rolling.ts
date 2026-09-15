/**
 * Rolling windows.
 *
 * The store keeps two horizons per metric:
 *
 * - **raw** — every normalized reading inside `windows.rawMs` (30 minutes by
 *   default). This is what short-window statistics, percentiles and
 *   consecutive-threshold durations are computed from.
 * - **aggregates** — one mean/max/min bucket per `windows.aggregateBucketMs`
 *   (5 minutes by default), retained for `windows.aggregateRetentionMs`
 *   (24 hours). This is what long-horizon trend detection reads, so a 4-hour
 *   memory leak is visible without keeping 4 hours of raw samples.
 *
 * Memory is bounded by construction: raw retention is a fixed duration and one
 * bucket is 32 bytes of bookkeeping. The store never grows with uptime.
 *
 * @module dsh-health-scheduler/core/rolling
 */

import type { CanonicalMetric, MetricBag } from '../types/index.js'
import type { AggregatedBucket, WindowStats } from '../types/window.js'
import type { WindowConfig } from '../types/config.js'

interface RawPoint {
  t: number
  v: number
}

interface Series {
  /** Ascending-time raw points, pruned on write. */
  points: RawPoint[]
  /** Insertion cursor optimisation: index of the oldest unpruned point. */
  head: number
  /** Ascending-time aggregate buckets, pruned on write. */
  buckets: AggregatedBucket[]
  /**
   * Timestamp at which the metric most recently entered its configured
   * threshold band, or `null` when it currently is not in one.
   */
  bandEnteredAt: number | null
  /** Last evaluated band key, so a band change resets the duration. */
  bandKey: string | null
  /** Most recent value, regardless of window. */
  latest: number | null
  /** Instant of {@link Series.latest}. */
  latestAt: number | null
}

/** Running totals while folding aggregate buckets into a day. */
interface BucketAccumulator {
  count: number
  /** `mean * count`, so means combine by weight rather than by arithmetic. */
  weightedMean: number
  max: number
  min: number
}

/** One metric's summary for one local day. */
export interface DailyMetricSummary {
  readonly metric: CanonicalMetric
  readonly count: number
  readonly mean: number
  readonly max: number
  readonly min: number
}

/** One local day of rolled-up health history. */
export interface DailySummary {
  /** Local midnight of the day, ISO-8601. */
  readonly dayStart: string
  /** Per-metric summaries, sorted by metric name. */
  readonly metrics: readonly DailyMetricSummary[]
}

/** Local midnight of the day containing `atMs`. */
function startOfLocalDay(atMs: number): number {
  const date = new Date(atMs)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function emptySeries(): Series {
  return {
    points: [],
    head: 0,
    buckets: [],
    bandEnteredAt: null,
    bandKey: null,
    latest: null,
    latestAt: null,
  }
}

/** Quantile of an already-sorted ascending array. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN
  if (sorted.length === 1) return sorted[0] as number
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const lo = sorted[lower] as number
  if (lower === upper) return lo
  const hi = sorted[upper] as number
  return lo + (hi - lo) * (position - lower)
}

/** Ordinary least-squares slope of `y` over `x`, in units per hour. */
function slopePerHour(points: readonly RawPoint[]): { slope: number; rSquared: number } | null {
  const n = points.length
  if (n < 2) return null
  let sumX = 0
  let sumY = 0
  for (const point of points) {
    sumX += point.t
    sumY += point.v
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const point of points) {
    const dx = point.t - meanX
    const dy = point.v - meanY
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  if (sxx === 0) return null
  const slopePerMs = sxy / sxx
  const rSquared = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy)
  return { slope: slopePerMs * 3_600_000, rSquared }
}

/**
 * One rolling store for every metric the plugin collects.
 */
export class RollingStore {
  private readonly series = new Map<CanonicalMetric, Series>()
  private readonly windows: WindowConfig
  /** Ascending window sizes in milliseconds. */
  readonly windowSizes: readonly number[]

  constructor(windows: WindowConfig) {
    this.windows = windows
    this.windowSizes = [...windows.windowsMs].sort((a, b) => a - b)
  }

  /** Longest retained raw horizon. */
  get rawHorizonMs(): number {
    return this.windows.rawMs
  }

  /**
   * Record one normalized metric value.
   *
   * @param metric - canonical metric name.
   * @param value - normalized value.
   * @param atMs - sample instant, epoch milliseconds.
   * @param bandKey - current threshold band identity (for consecutive
   *   duration). Pass `null` when the metric is inside no band.
   */
  record(metric: CanonicalMetric, value: number, atMs: number, bandKey: string | null = null): void {
    let entry = this.series.get(metric)
    if (entry === undefined) {
      entry = emptySeries()
      this.series.set(metric, entry)
    }

    entry.points.push({ t: atMs, v: value })
    entry.latest = value
    entry.latestAt = atMs

    // Band bookkeeping runs on every recorded point so a metric that leaves and
    // re-enters a band restarts its duration instead of accumulating across gaps.
    if (bandKey === null) {
      entry.bandKey = null
      entry.bandEnteredAt = null
    } else if (entry.bandKey !== bandKey) {
      entry.bandKey = bandKey
      entry.bandEnteredAt = atMs
    }

    const rawCutoff = atMs - this.windows.rawMs
    while (entry.head < entry.points.length) {
      const point = entry.points[entry.head] as RawPoint
      if (point.t >= rawCutoff) break
      entry.head += 1
    }
    if (entry.head > 512 && entry.head * 2 > entry.points.length) {
      entry.points = entry.points.slice(entry.head)
      entry.head = 0
    }

    const bucketMs = this.windows.aggregateBucketMs
    const bucketStart = Math.floor(atMs / bucketMs) * bucketMs
    const last = entry.buckets[entry.buckets.length - 1]
    if (last !== undefined && last.startMs === bucketStart) {
      const count = last.count + 1
      const mean = (last.mean * last.count + value) / count
      entry.buckets[entry.buckets.length - 1] = {
        startMs: bucketStart,
        bucketMs,
        count,
        mean,
        max: Math.max(last.max, value),
        min: Math.min(last.min, value),
      }
    } else {
      entry.buckets.push({ startMs: bucketStart, bucketMs, count: 1, mean: value, max: value, min: value })
    }

    const bucketCutoff = atMs - this.windows.aggregateRetentionMs
    let drop = 0
    while (drop < entry.buckets.length && (entry.buckets[drop] as AggregatedBucket).startMs < bucketCutoff) {
      drop += 1
    }
    if (drop > 0) entry.buckets = entry.buckets.slice(drop)
  }

  /**
   * Declare which threshold band a metric currently sits in.
   *
   * Returning the duration from here — instead of making the caller read
   * {@link RollingStore.consecutiveMs} and hope the band bookkeeping agrees —
   * keeps the sustain gate honest: the number the caller gates on is the number
   * the store just recorded.
   *
   * @param metric - canonical metric name.
   * @param bandKey - stable band identity, or `null` when outside every band.
   * @param atMs - evaluation instant.
   * @returns milliseconds the metric has continuously held `bandKey`.
   */
  declareBand(metric: CanonicalMetric, bandKey: string | null, atMs: number): number {
    let entry = this.series.get(metric)
    if (entry === undefined) {
      entry = emptySeries()
      this.series.set(metric, entry)
    }
    if (bandKey === null) {
      entry.bandKey = null
      entry.bandEnteredAt = null
      return 0
    }
    if (entry.bandKey !== bandKey || entry.bandEnteredAt === null) {
      entry.bandKey = bandKey
      entry.bandEnteredAt = atMs
      return 0
    }
    return Math.max(0, atMs - entry.bandEnteredAt)
  }

  /**
   * Record every metric of a normalized bag.
   *
   * @param bag - normalized metrics.
   * @param atMs - sample instant.
   * @param bandOf - optional band identity per metric, so the store can time how
   *   long each metric has held its band. This is what the sustain gate reads:
   *   recording the band here means the duration is a property of the data, not
   *   of when somebody happened to ask.
   */
  recordBag(
    bag: MetricBag,
    atMs: number,
    bandOf?: (metric: CanonicalMetric, value: number) => string | null,
  ): void {
    for (const [metric, value] of Object.entries(bag) as Array<[CanonicalMetric, number]>) {
      this.record(metric, value, atMs, bandOf === undefined ? null : bandOf(metric, value))
    }
  }

  /** Latest value of a metric, or `null`. */
  latest(metric: CanonicalMetric): number | null {
    return this.series.get(metric)?.latest ?? null
  }

  /** Instant of the latest value, or `null`. */
  latestAt(metric: CanonicalMetric): number | null {
    return this.series.get(metric)?.latestAt ?? null
  }

  /** Milliseconds the metric has held its current band, or `0`. */
  consecutiveMs(metric: CanonicalMetric, nowMs: number): number {
    const entry = this.series.get(metric)
    if (entry === undefined || entry.bandEnteredAt === null) return 0
    return Math.max(0, nowMs - entry.bandEnteredAt)
  }

  /** Metrics with at least one recorded point. */
  metrics(): readonly CanonicalMetric[] {
    return [...this.series.keys()].sort()
  }

  /** Raw points inside a window, newest last. */
  rawPoints(metric: CanonicalMetric, windowMs: number, nowMs: number): readonly RawPoint[] {
    const entry = this.series.get(metric)
    if (entry === undefined) return []
    const cutoff = nowMs - windowMs
    const out: RawPoint[] = []
    for (let i = entry.head; i < entry.points.length; i += 1) {
      const point = entry.points[i] as RawPoint
      if (point.t >= cutoff) out.push(point)
    }
    return out
  }

  /** Aggregate buckets retained for a metric, oldest first. */
  buckets(metric: CanonicalMetric): readonly AggregatedBucket[] {
    return this.series.get(metric)?.buckets ?? []
  }

  /** Total raw points held across every metric, for diagnostics and tests. */
  size(): number {
    let total = 0
    for (const entry of this.series.values()) total += entry.points.length - entry.head
    return total
  }

  /** Drop everything. Used by tests and by an explicit user reset. */
  clear(): void {
    this.series.clear()
  }

  /**
   * Roll the retained aggregate buckets up into per-day summaries.
   *
   * A day summary is four numbers per metric — mean, max, min and sample count
   * over one local day — which is what "was last Tuesday worse than today?"
   * actually needs. Raw samples are never kept for this; the aggregates are
   * already bucketed, so the cost is proportional to the number of buckets, not
   * to uptime.
   *
   * @param nowMs - evaluation instant, used to drop summaries past the horizon.
   * @returns per-day summaries, oldest day first, each with metrics sorted by name.
   */
  dailySummaries(nowMs: number): readonly DailySummary[] {
    const horizonStart = nowMs - this.windows.dailyRetentionMs
    const MetricKeep = new Map<number, Map<CanonicalMetric, BucketAccumulator>>()

    for (const [metric, entry] of this.series) {
      for (const bucket of entry.buckets) {
        if (bucket.startMs < horizonStart) continue
        const dayStart = startOfLocalDay(bucket.startMs)
        let byMetric = MetricKeep.get(dayStart)
        if (byMetric === undefined) {
          byMetric = new Map()
          MetricKeep.set(dayStart, byMetric)
        }
        const accumulator = byMetric.get(metric)
        // Combine means by sample count so a quiet hour cannot outvote a busy one.
        if (accumulator === undefined) {
          byMetric.set(metric, {
            count: bucket.count,
            weightedMean: bucket.mean * bucket.count,
            max: bucket.max,
            min: bucket.min,
          })
        } else {
          accumulator.count += bucket.count
          accumulator.weightedMean += bucket.mean * bucket.count
          accumulator.max = Math.max(accumulator.max, bucket.max)
          accumulator.min = Math.min(accumulator.min, bucket.min)
        }
      }
    }

    const days = [...MetricKeep.keys()].sort((a, b) => a - b)
    return days.map((dayStartMs) => {
      const byMetric = MetricKeep.get(dayStartMs) as Map<CanonicalMetric, BucketAccumulator>
      const metrics: DailyMetricSummary[] = [...byMetric.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([metric, accumulator]) => ({
          metric,
          count: accumulator.count,
          mean: accumulator.weightedMean / accumulator.count,
          max: accumulator.max,
          min: accumulator.min,
        }))
      return {
        dayStart: new Date(dayStartMs).toISOString(),
        metrics,
      }
    })
  }

  /**
   * Statistics of one metric over one window.
   *
   * @param metric - canonical metric name.
   * @param windowMs - window length in milliseconds.
   * @param nowMs - evaluation instant.
   */
  stats(metric: CanonicalMetric, windowMs: number, nowMs: number): WindowStats {
    const points = this.rawPoints(metric, windowMs, nowMs)
    const values = points.map((point) => point.v)
    const sorted = [...values].sort((a, b) => a - b)
    const count = values.length
    const fit = slopePerHour(points)
    const first = points[0]
    const last = points[points.length - 1]

    return {
      metric,
      windowMs,
      count,
      mean: count === 0 ? null : values.reduce((sum, value) => sum + value, 0) / count,
      median: count === 0 ? null : quantile(sorted, 0.5),
      p95: count === 0 ? null : quantile(sorted, 0.95),
      max: count === 0 ? null : (sorted[count - 1] as number),
      min: count === 0 ? null : (sorted[0] as number),
      latest: last?.v ?? null,
      earliest: first?.v ?? null,
      changeRate: first !== undefined && last !== undefined ? last.v - first.v : null,
      changeFraction:
        first !== undefined && last !== undefined && first.v !== 0 ? (last.v - first.v) / Math.abs(first.v) : null,
      slopePerHour: fit?.slope ?? null,
      rSquared: fit?.rSquared ?? null,
      consecutiveMs: this.consecutiveMs(metric, nowMs),
      spanMs: first !== undefined && last !== undefined ? last.t - first.t : 0,
    }
  }

  /** Every window's statistics for one metric, in ascending window order. */
  statsByWindow(metric: CanonicalMetric, nowMs: number): readonly WindowStats[] {
    return this.windowSizes.map((windowMs) => this.stats(metric, windowMs, nowMs))
  }

  /**
   * Fit a trend over the aggregate buckets, for horizons longer than raw retention.
   *
   * Raw samples cover `windows.rawMs`; anything longer — a working day, a week of
   * daily summaries — can only be fitted from the aggregates. Without this the
   * buckets would be collected and never read, which is how a "24 h leak" ends up
   * invisible on a machine whose raw horizon is 6 hours.
   *
   * @param metric - canonical metric name.
   * @param horizonMs - look-back horizon.
   * @param nowMs - evaluation instant.
   * @returns a least-squares fit in units per hour over bucket means, or `null`.
   */
  fitBuckets(
    metric: CanonicalMetric,
    horizonMs: number,
    nowMs: number,
  ): { readonly slopePerHour: number; readonly rSquared: number; readonly count: number; readonly spanMs: number } | null {
    const cutoff = nowMs - horizonMs
    const points = this.buckets(metric)
      .filter((bucket) => bucket.startMs >= cutoff)
      .map((bucket) => ({ t: bucket.startMs, v: bucket.mean }))
    if (points.length < 2) return null
    const fit = slopePerHour(points)
    if (fit === null) return null
    const first = points[0] as RawPoint
    const last = points[points.length - 1] as RawPoint
    return { slopePerHour: fit.slope, rSquared: fit.rSquared, count: points.length, spanMs: last.t - first.t }
  }

  /** All metric statistics for one window, sorted by metric name. */
  snapshot(windowMs: number, nowMs: number): readonly WindowStats[] {
    return this.metrics().map((metric) => this.stats(metric, windowMs, nowMs))
  }
}
