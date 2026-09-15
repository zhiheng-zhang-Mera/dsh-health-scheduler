/**
 * Presentation helpers: the JSON payload the tools return and the plain-text
 * report a human reads.
 *
 * Both are derived from {@link HealthSnapshot}, so the model and the UI can never
 * disagree about what the numbers were — and every sentence here is backed by a
 * metric, which is the design's rule against "the AI thought it should restart".
 *
 * @module dsh-health-scheduler/dsh/report
 */

import type { HealthSnapshot } from '../core/scheduler.js'
import { formatBytes } from '../core/trend.js'
import { formatDuration } from '../core/maintenance.js'

/** Compact JSON payload for the model and for HTTP consumers. */
export function metricsSnapshot(snapshot: HealthSnapshot): Record<string, unknown> {
  return {
    timestamp: snapshot.timestamp,
    state: snapshot.state,
    action: snapshot.action,
    restart_pressure: snapshot.pressure,
    coverage: snapshot.coverage,
    primary_cause: snapshot.primaryCause,
    unknown_dimensions: snapshot.unknownDimensions,
    capabilities: snapshot.capabilities,
    maintenance: {
      phase: snapshot.maintenance.phase,
      window_open: snapshot.maintenance.windowOpen,
      next_target_at: snapshot.maintenance.nextTargetAt,
      deferred_ms: snapshot.maintenance.deferredMs,
      defer_exhausted: snapshot.maintenance.deferExhausted,
      urgent_override: snapshot.maintenance.urgentOverride,
      summary: snapshot.maintenance.summary,
    },
    safe_point: {
      safe: snapshot.readiness.safe,
      reason: snapshot.readiness.reason,
      estimated_state: snapshot.readiness.estimated_state,
      summary: snapshot.readiness.summary,
    },
    dimensions: snapshot.dimensions.map((dimension) => ({
      dimension: dimension.dimension,
      score: dimension.score,
      level: dimension.level,
      weight: dimension.weight,
      effective_weight: Number(dimension.effectiveWeight.toFixed(4)),
      summary: dimension.summary,
      metrics: dimension.metrics.map((metric) => ({
        metric: metric.metric,
        value: metric.value,
        score: metric.score,
        level: metric.level,
        rule: metric.rule,
        sustained_ms: metric.sustainedMs,
        trend_applied: metric.trendApplied,
      })),
    })),
    drivers: snapshot.drivers.map((driver) => ({
      code: driver.code,
      dimension: driver.dimension,
      contribution: driver.contribution,
      detail: driver.detail,
    })),
    trends: snapshot.trends.map((trend) => ({
      metric: trend.metric,
      direction: trend.direction,
      slope_per_hour: trend.slopePerHour,
      r_squared: trend.rSquared,
      span_ms: trend.spanMs,
      summary: trend.summary,
    })),
    providers: snapshot.providers.map((provider) => ({
      id: provider.id,
      group: provider.group,
      available: provider.available,
      consecutive_failures: provider.consecutiveFailures,
      total_failures: provider.totalFailures,
      backoff_remaining_ms: provider.backoffRemainingMs,
      last_success_at: provider.lastSuccessAt,
      last_error: provider.lastError,
    })),
    metrics: snapshot.metrics,
    daily_summaries: snapshot.dailySummaries.map((day) => ({
      day_start: day.dayStart,
      metrics: day.metrics.map((metric) => ({
        metric: metric.metric,
        count: metric.count,
        mean: metric.mean,
        max: metric.max,
        min: metric.min,
      })),
    })),
    recent_decisions: snapshot.recentDecisions.map((record) => ({
      id: record.id,
      timestamp: record.timestamp,
      action: record.action,
      state: record.state,
      pressure: record.pressure,
      coverage: record.coverage,
      reasons: record.reasons,
      outcome: record.outcome,
    })),
    warnings: snapshot.warnings,
  }
}

/** Plain-text report, sized for a terminal or a chat message. */
export function renderHealthReport(snapshot: HealthSnapshot): string {
  const lines: string[] = []
  const pressure = snapshot.pressure === null ? 'unknown' : `${snapshot.pressure} / 100`
  lines.push(`Restart Pressure: ${pressure}`)
  lines.push(`State: ${snapshot.state}`)
  lines.push(`Primary Cause: ${snapshot.primaryCause ?? 'none'}`)
  lines.push(`Telemetry coverage: ${Math.round(snapshot.coverage * 100)}%`)
  if (snapshot.unknownDimensions.length > 0) {
    lines.push(`Unknown dimensions: ${snapshot.unknownDimensions.join(', ')} (not scored as healthy)`)
  }
  lines.push(`Maintenance: ${snapshot.maintenance.summary}`)
  lines.push(`Safe point: ${snapshot.readiness.summary}`)
  lines.push(
    `Capabilities: restart=${snapshot.capabilities.restart}, worker-control=${snapshot.capabilities.workerControl}`,
  )
  lines.push('')
  lines.push('Dimensions:')
  for (const dimension of snapshot.dimensions) {
    const score = dimension.score === null ? 'unknown' : `${dimension.score}`
    lines.push(
      `  ${dimension.dimension.padEnd(16)} ${score.padStart(7)}  ${dimension.level.padEnd(8)} weight=${dimension.weight}`,
    )
  }
  if (snapshot.drivers.length > 0) {
    lines.push('')
    lines.push('Drivers:')
    for (const driver of snapshot.drivers.slice(0, 6)) {
      lines.push(`  [${driver.contribution.toFixed(1)} pts] ${driver.code}: ${driver.detail}`)
    }
  }
  if (snapshot.trends.length > 0) {
    lines.push('')
    lines.push('Worsening trends:')
    for (const trend of snapshot.trends.slice(0, 6)) {
      lines.push(`  ${trend.metric}: ${trend.summary}`)
    }
  }
  lines.push('')
  lines.push('Providers:')
  for (const provider of snapshot.providers) {
    const status = provider.available
      ? `ok (${provider.totalSuccesses} samples)`
      : `unavailable (${provider.consecutiveFailures} consecutive failures, backoff ${formatDuration(provider.backoffRemainingMs)})`
    lines.push(`  ${provider.id.padEnd(16)} ${status}${provider.lastError === null ? '' : ` — ${provider.lastError}`}`)
  }
  lines.push('')
  lines.push('Memory:')
  lines.push(`  process RSS: ${formatBytes(snapshot.metrics.process_rss_bytes ?? 0)}`)
  lines.push(`  RAM used: ${snapshot.metrics.ram_used_ratio === undefined || snapshot.metrics.ram_used_ratio === null ? 'unknown' : `${Math.round((snapshot.metrics.ram_used_ratio as number) * 100)}%`}`)
  if (snapshot.recentDecisions.length > 0) {
    lines.push('')
    lines.push('Recent decisions (newest last):')
    for (const record of snapshot.recentDecisions.slice(-5)) {
      lines.push(
        `  #${record.id} ${record.timestamp} ${record.action} -> ${record.state} (pressure ${record.pressure ?? 'unknown'}, ${record.outcome.applied ? 'applied' : 'not applied'})`,
      )
      lines.push(`      reasons: ${record.reasons.slice(0, 5).join(', ')}`)
    }
  }
  if (snapshot.warnings.length > 0) {
    lines.push('')
    lines.push('Warnings:')
    for (const warning of snapshot.warnings) lines.push(`  - ${warning}`)
  }
  return lines.join('\n')
}

/** Render one metric table row. Exported for the tests' golden output. */
export function renderMetricRow(name: string, value: number | null): string {
  return `${name.padEnd(28)} ${value === null ? 'unknown' : value}`
}
