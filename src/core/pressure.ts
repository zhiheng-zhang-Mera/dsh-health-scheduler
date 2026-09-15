/**
 * The pressure engine.
 *
 * Turns rolling statistics into one number a human can argue with:
 * `restart_pressure = 0..100`. Six dimensions contribute with configurable
 * weights; within a dimension each metric ramps through its own band and may add
 * a trend term on top.
 *
 * Two rules are non-negotiable here:
 *
 * 1. **Missing telemetry is not health.** A dimension with no data is reported as
 *    `unknown` with `score: null`. Its configured weight is redistributed over
 *    the dimensions that do have data, and the redistributed share is published
 *    as {@link PressureSnapshot.coverage} so a 40 %-coverage pressure can never be
 *    mistaken for a full-confidence one.
 * 2. **The worst metric leads.** A dimension's score is a weighted blend of the
 *    weighted mean and the worst member, so a single critical metric is not
 *    averaged away by five calm ones.
 *
 * @module dsh-health-scheduler/core/pressure
 */

import {
  PRESSURE_DIMENSIONS,
  type HealthSchedulerConfig,
  type MetricConfig,
} from '../types/config.js'
import type {
  DimensionPressure,
  MetricPressure,
  PressureDimension,
  PressureDriver,
  PressureSnapshot,
} from '../types/decision.js'
import type { CanonicalMetric } from '../types/metrics.js'
import { clamp, describeRule, levelOf, scoreWithSustain } from './bands.js'
import type { RollingStore } from './rolling.js'
import { formatDelta, formatSlopePerHour, TrendAnalyzer } from './trend.js'

/**
 * Canonical metric to pressure dimension.
 *
 * `runtime` metrics stay visible through the runtime dimension; the memory
 * dimension owns only real memory telemetry. Handle and thread growth reaches
 * pressure as explicit runtime-degradation drivers in the policy layer rather
 * than by being double-counted here.
 */
const METRIC_DIMENSION: Readonly<Record<CanonicalMetric, PressureDimension>> = Object.freeze({
  cpu_temp_c: 'thermal',
  gpu_temp_c: 'thermal',
  cpu_usage: 'thermal',
  gpu_usage: 'thermal',
  thermal_throttle: 'thermal',
  power_limit_hit: 'thermal',

  ram_total_bytes: 'memory',
  ram_available_bytes: 'memory',
  ram_used_ratio: 'memory',
  commit_used_ratio: 'memory',
  process_rss_bytes: 'memory',
  process_private_bytes: 'memory',
  vram_used_ratio: 'memory',

  uptime_seconds: 'time',
  worker_process_count: 'runtime',
  handle_count: 'runtime',
  thread_count: 'runtime',
  event_loop_latency_ms: 'runtime',
  heartbeat_delay_ms: 'runtime',
  restart_count: 'runtime',
  ipc_timeout_rate: 'runtime',

  active_workers: 'worker',
  queued_tasks: 'worker',
  task_latency_ms: 'worker',
  timeout_rate: 'worker',
  retry_rate: 'worker',
  failure_rate: 'worker',
  spawn_failure_rate: 'worker',
  abnormal_exit_rate: 'worker',
  queue_delay_ms: 'worker',

  screenshot_latency_ms: 'computer_use_ui',
  action_latency_ms: 'computer_use_ui',
  verification_retry_rate: 'computer_use_ui',
  missed_target_rate: 'computer_use_ui',
  recovery_rate: 'computer_use_ui',
  desktop_responsiveness_ms: 'computer_use_ui',

  render_latency_ms: 'computer_use_ui',
  main_window_heartbeat_ms: 'computer_use_ui',
  blank_frame_rate: 'computer_use_ui',
  frontend_error_rate: 'computer_use_ui',

  task_failure_rate: 'worker',
  git_operations_per_minute: 'time',
})

/** Dimension of a metric, defaulting to `runtime` for anything unmapped. */
export function dimensionOf(metric: CanonicalMetric): PressureDimension {
  return METRIC_DIMENSION[metric] ?? 'runtime'
}

/** Where the uptime ramp starts contributing pressure. */
export const UPTIME_RAMP_START_MS = 8 * 3_600_000
/** Where the uptime ramp saturates; past this, time pressure is a full 100. */
export const UPTIME_RAMP_FULL_MS = 14 * 24 * 3_600_000

/** Blend factor between the weighted mean and the worst metric of a dimension. */
const WORST_WEIGHT = 0.5

/** Inputs the engine needs beyond the store. */
export interface PressureInputs {
  /** Evaluation instant. */
  readonly nowMs: number
  /** ISO-8601 form of {@link PressureInputs.nowMs}. */
  readonly timestamp: string
  /**
   * Total system uptime in milliseconds, when a runtime provider reports it.
   * `null` means "not measured", which makes the time dimension unknown.
   */
  readonly uptimeMs: number | null
  /** Restart count observed since the supervisor started, when available. */
  readonly restartCount: number | null
}

/**
 * Compute pressure from rolling statistics.
 *
 * The engine is stateless apart from the store it reads; constructing a new one
 * per tick is cheap and keeps the tick free of hidden state.
 */
export class PressureEngine {
  private readonly store: RollingStore
  private readonly trends: TrendAnalyzer
  private readonly config: HealthSchedulerConfig

  constructor(store: RollingStore, trends: TrendAnalyzer, config: HealthSchedulerConfig) {
    this.store = store
    this.trends = trends
    this.config = config
  }

  /**
   * Evaluate the complete pressure picture.
   *
   * @param inputs - evaluation instant and context measurements.
   */
  evaluate(inputs: PressureInputs): PressureSnapshot {
    const trendHorizonMs = this.config.windows.windowsMs[this.config.windows.windowsMs.length - 1] ?? 3_600_000
    const dimensions: DimensionPressure[] = []
    const drivers: PressureDriver[] = []

    for (const dimension of PRESSURE_DIMENSIONS) {
      const nominal = this.config.weights[dimension] ?? 0
      const evaluations = this.evaluateDimension(dimension, inputs, trendHorizonMs)
      const known = evaluations.filter((entry) => entry.score !== null)
      const score = combineScores(known, (metric) => this.config.metrics[metric]?.weight ?? 1)
      const level = levelOf(score)
      dimensions.push({
        dimension,
        score,
        level,
        weight: nominal,
        effectiveWeight: 0, // filled after renormalization
        metrics: evaluations,
        summary: summarizeDimension(dimension, score, level, evaluations),
      })
      if (nominal > 0 && score !== null) {
        for (const entry of evaluations) {
          const driver = driverFor(dimension, entry)
          if (driver !== null) drivers.push(driver)
        }
      }
    }

    const knownWeight = dimensions
      .filter((entry) => entry.score !== null)
      .reduce((sum, entry) => sum + entry.weight, 0)
    const totalWeight = dimensions.reduce((sum, entry) => sum + entry.weight, 0)
    const coverage = totalWeight > 0 ? knownWeight / totalWeight : 0

    const withEffective = dimensions.map((entry) => ({
      ...entry,
      effectiveWeight: entry.score !== null && knownWeight > 0 ? entry.weight / knownWeight : 0,
    }))

    let restartPressure: number | null = null
    if (knownWeight > 0) {
      let weighted = 0
      for (const entry of withEffective) {
        if (entry.score === null) continue
        weighted += entry.score * entry.effectiveWeight
      }
      restartPressure = Math.round(clamp(weighted, 0, 100))
    }

    const effectiveByDimension = new Map(withEffective.map((entry) => [entry.dimension, entry.effectiveWeight]))
    const scored = drivers
      .map((driver) => {
        const effective = effectiveByDimension.get(driver.dimension) ?? 0
        return { ...driver, contribution: round1(driver.contribution * effective) }
      })
      .filter((driver) => driver.contribution > 0)
      .sort((a, b) => b.contribution - a.contribution)

    return {
      timestamp: inputs.timestamp,
      restartPressure,
      coverage: round3(coverage),
      unknownDimensions: withEffective.filter((entry) => entry.score === null).map((entry) => entry.dimension),
      dimensions: withEffective,
      drivers: scored,
      primaryCause: scored[0]?.detail ?? null,
    }
  }

  /** Evaluate every configured metric of one dimension. */
  private evaluateDimension(
    dimension: PressureDimension,
    inputs: PressureInputs,
    trendHorizonMs: number,
  ): MetricPressure[] {
    const out: MetricPressure[] = []

    if (dimension === 'time') {
      out.push(this.evaluateTime(inputs))
    }

    const metrics = (Object.keys(METRIC_DIMENSION) as CanonicalMetric[])
      .filter((metric) => METRIC_DIMENSION[metric] === dimension)
      .sort()

    for (const metric of metrics) {
      if (dimension === 'time' && metric === 'uptime_seconds') continue
      const metricConfig = this.config.metrics[metric]
      if (metricConfig === undefined) continue
      const entry = this.evaluateMetric(metric, metricConfig, inputs, trendHorizonMs)
      if (entry !== null) out.push(entry)
    }

    return out
  }

  /** The time dimension: one uptime ramp, no sensor involved. */
  private evaluateTime(inputs: PressureInputs): MetricPressure {
    const value = inputs.uptimeMs === null ? null : inputs.uptimeMs / 1000
    if (value === null) {
      return {
        metric: 'uptime_seconds',
        value: null,
        score: null,
        level: 'unknown',
        rule: 'uptime telemetry unavailable',
        sustainedMs: 0,
        trendApplied: false,
      }
    }
    const span = UPTIME_RAMP_FULL_MS - UPTIME_RAMP_START_MS
    const score = Math.round(clamp(((inputs.uptimeMs as number) - UPTIME_RAMP_START_MS) / span, 0, 1) * 100)
    return {
      metric: 'uptime_seconds',
      value,
      score,
      level: levelOf(score),
      rule: `uptime ramp over ${Math.round(UPTIME_RAMP_START_MS / 3_600_000)}h..${Math.round(UPTIME_RAMP_FULL_MS / 3_600_000)}h`,
      sustainedMs: Math.round(inputs.uptimeMs as number),
      trendApplied: false,
    }
  }

  /** Score one metric, including its optional trend term. */
  private evaluateMetric(
    metric: CanonicalMetric,
    metricConfig: MetricConfig,
    inputs: PressureInputs,
    trendHorizonMs: number,
  ): MetricPressure | null {
    const latest = this.store.latest(metric)
    if (latest === null) return null

    const sustainMs = metricConfig.sustainMs ?? 0
    let score: number | null = null
    let rule = 'observational only'
    let sustainedMs = 0

    if (metricConfig.band !== undefined) {
      // The band a value sits in was declared when it was recorded, so the
      // duration read here is the duration the store actually observed.
      const held = this.store.consecutiveMs(metric, inputs.nowMs)
      const gated = scoreWithSustain(metric, latest, metricConfig.band, sustainMs, held)
      score = gated.score
      sustainedMs = gated.sustainedMs
      rule = describeRule(metric, metricConfig.band, sustainMs, held)
    }

    let trendApplied = false
    const trendPoints = metricConfig.trendPointsPerHour ?? 0
    if (trendPoints > 0) {
      const trend = this.trends.evaluate(metric, inputs.nowMs, trendHorizonMs)
      if (trend.isWorsening && trend.slopePerHour !== null) {
        const perHour = Math.abs(trend.slopePerHour)
        const reference = this.referenceSlope(metric)
        const relative = reference === null ? 1 : clamp(perHour / reference, 0, 2)
        const cap = metricConfig.trendCap ?? 25
        const trendScore = Math.round(clamp(relative * trendPoints, 0, cap))
        if (trendScore > 0) {
          score = clamp((score ?? 0) + trendScore, 0, 100)
          trendApplied = true
          rule = `${rule}; trend ${formatSlopePerHour(metric, trend.slopePerHour)} adds ${trendScore}`
        }
      }
    }

    if (score === null && !trendApplied) {
      // Collected but unscored: still report the observation so the UI can show it.
      return {
        metric,
        value: latest,
        score: null,
        level: 'unknown',
        rule: 'collected, not scored',
        sustainedMs,
        trendApplied: false,
      }
    }

    return {
      metric,
      value: latest,
      score,
      level: levelOf(score),
      rule,
      sustainedMs,
      trendApplied,
    }
  }

  /** A metric's "meaningful" slope, used to normalize trend contributions. */
  private referenceSlope(metric: CanonicalMetric): number | null {
    const metricConfig = this.config.metrics[metric]
    if (metricConfig?.band === undefined) return null
    const span = Math.abs(metricConfig.band.critical - metricConfig.band.warn)
    return span === 0 ? null : span
  }
}

/** Blend the known metric scores of one dimension into a dimension score. */
function combineScores(
  entries: readonly MetricPressure[],
  weightOf: (metric: CanonicalMetric) => number,
): number | null {
  const known = entries.filter((entry): entry is MetricPressure & { score: number } => entry.score !== null)
  if (known.length === 0) return null
  const worst = known.reduce((max, entry) => Math.max(max, entry.score), 0)
  let weightSum = 0
  let weighted = 0
  for (const entry of known) {
    const weight = Math.max(0, weightOf(entry.metric))
    weighted += entry.score * weight
    weightSum += weight
  }
  const mean = weightSum === 0 ? worst : weighted / weightSum
  return Math.round(clamp(mean * (1 - WORST_WEIGHT) + worst * WORST_WEIGHT, 0, 100))
}

/** One-line dimension summary for the UI and the audit log. */
function summarizeDimension(
  dimension: PressureDimension,
  score: number | null,
  level: string,
  entries: readonly MetricPressure[],
): string {
  if (score === null) return `${dimension}: no telemetry (unknown)`
  const worst = entries
    .filter((entry) => entry.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
  if (worst === undefined) return `${dimension}: ${score}/100 (${level})`
  return `${dimension}: ${score}/100 (${level}), led by ${worst.metric}=${formatValue(worst.metric, worst.value)}`
}

/** Format a metric value for a summary line. */
function formatValue(metric: CanonicalMetric, value: number | null): string {
  if (value === null) return 'unknown'
  return formatDelta(metric, value)
}

/** Build an explainable driver for a metric that is actually contributing. */
function driverFor(dimension: PressureDimension, entry: MetricPressure): PressureDriver | null {
  if (entry.score === null || entry.score < 35) return null
  const code = driverCode(dimension, entry)
  const contribution = round1(entry.score / 100)
  const sustain = entry.sustainedMs > 0 ? `, held ${Math.round(entry.sustainedMs / 1000)}s` : ''
  const trend = entry.trendApplied ? ', worsening trend' : ''
  return {
    code,
    dimension,
    contribution,
    detail: `${entry.metric}=${formatValue(entry.metric, entry.value)} scores ${entry.score}/100${sustain}${trend}`,
  }
}

/** Stable driver code for a metric. */
function driverCode(dimension: PressureDimension, entry: MetricPressure): string {
  if (entry.trendApplied && entry.score !== null && entry.score >= 35) {
    return `${entry.metric}_slope_high`
  }
  switch (dimension) {
    case 'thermal':
      return `${entry.metric}_critical`
    case 'memory':
      return `${entry.metric}_pressure`
    case 'runtime':
      return `runtime_${entry.metric}_degraded`
    case 'worker':
      return `worker_${entry.metric}_elevated`
    case 'computer_use_ui':
      return `interactive_${entry.metric}_degraded`
    case 'time':
      return 'uptime_pressure'
    default:
      return `${entry.metric}_elevated`
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
