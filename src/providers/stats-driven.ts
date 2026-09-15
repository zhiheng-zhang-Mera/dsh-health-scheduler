/**
 * Worker, Computer Use and UI providers, plus the external-metrics provider.
 *
 * These four read the same sanctioned seam: a stats file or a command probe
 * written by the component that owns the numbers (the harness job/worker layer,
 * the Computer Use runtime, the web client's telemetry, or any integration). The
 * plugin does not instrument worker internals or the renderer — that would be the
 * kind of coupling the design forbids, and it would break on the next harness
 * release.
 *
 * Each provider exposes only its own metric group, so the Health page can show
 * "Workers: unknown" without any risk of that being read as "Workers: healthy".
 *
 * @module dsh-health-scheduler/providers/stats-driven
 */

import type { CanonicalMetric } from '../types/metrics.js'
import type { HealthProvider, HealthSample } from '../types/provider.js'
import type { ProviderEnvironment } from './environment.js'
import type { StatsFileSnapshot, StatsFileSource } from './sources.js'

const WORKER_METRICS: readonly CanonicalMetric[] = [
  'abnormal_exit_rate',
  'active_workers',
  'failure_rate',
  'queue_delay_ms',
  'queued_tasks',
  'retry_rate',
  'spawn_failure_rate',
  'task_latency_ms',
  'timeout_rate',
]

const COMPUTER_USE_METRICS: readonly CanonicalMetric[] = [
  'action_latency_ms',
  'desktop_responsiveness_ms',
  'missed_target_rate',
  'recovery_rate',
  'screenshot_latency_ms',
  'verification_retry_rate',
]

const UI_METRICS: readonly CanonicalMetric[] = [
  'blank_frame_rate',
  'frontend_error_rate',
  'main_window_heartbeat_ms',
  'render_latency_ms',
]

const CONTEXT_METRICS: readonly CanonicalMetric[] = ['git_operations_per_minute', 'task_failure_rate']

/**
 * One provider over a subset of the external stats.
 *
 * `required` lists the metrics whose absence is worth reporting as degraded even
 * when the file was read successfully; the design's acceptance criteria include
 * "no telemetry is marked unknown, not healthy", and this is where that becomes
 * observable.
 */
export class StatsBackedProvider implements HealthProvider {
  readonly id: string
  readonly group: HealthProvider['group']
  readonly provides: readonly CanonicalMetric[]
  readonly enabled = true
  /** Metrics whose absence marks the sample degraded. */
  readonly required: readonly CanonicalMetric[]

  private readonly source: StatsFileSource
  private readonly environment: ProviderEnvironment
  private readonly extraProbes: readonly (readonly string[])[]

  constructor(options: {
    id: string
    group: HealthProvider['group']
    provides: readonly CanonicalMetric[]
    required?: readonly CanonicalMetric[]
    source: StatsFileSource
    environment: ProviderEnvironment
    extraProbes?: readonly (readonly string[])[]
  }) {
    this.id = options.id
    this.group = options.group
    this.provides = options.provides
    this.required = options.required ?? options.provides
    this.source = options.source
    this.environment = options.environment
    this.extraProbes = options.extraProbes ?? []
  }

  async sample(): Promise<HealthSample> {
    const nowMs = this.environment.clock()
    const timestamp = new Date(nowMs).toISOString()
    const snapshot: StatsFileSnapshot = this.source.read(nowMs)
    const metrics: Record<string, number> = {}
    const notes: string[] = []

    for (const metric of this.provides) {
      const value = snapshot.metrics[metric]
      if (value !== undefined) metrics[metric] = value
    }

    for (const argv of this.extraProbes) {
      if (argv.length === 0) continue
      const result = await this.environment.runProbe({ argv, timeoutMs: 5_000, format: 'name-value' })
      if (result.error !== null) {
        notes.push(`probe ${argv[0]} failed: ${result.error}`)
        continue
      }
      for (const metric of this.provides) {
        const value = result.metrics[metric]
        if (value !== undefined) metrics[metric] = value
      }
    }

    const missing = this.required.filter((metric) => metrics[metric] === undefined)
    const degraded = missing.length > 0 || snapshot.stale
    if (snapshot.detail !== null) notes.push(snapshot.detail)
    if (missing.length > 0) notes.push(`no telemetry for ${missing.join(', ')}`)
    if (snapshot.unknownKeys.length > 0) {
      notes.push(`stats file contains non-canonical keys: ${snapshot.unknownKeys.join(', ')}`)
    }

    return {
      provider: this.id,
      timestamp,
      metrics,
      ...(degraded ? { degraded: true } : {}),
      ...(degraded ? { degradedReason: (snapshot.reason ?? 'telemetry_unavailable') as HealthSample['degradedReason'] } : {}),
      ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    }
  }
}

/** Provider ids of the four stats-backed providers, in registration order. */
export const STATS_PROVIDER_IDS: readonly string[] = Object.freeze([
  'workers',
  'computer-use',
  'ui',
  'context',
])

/** Build the four stats-backed providers over one shared source. */
export function buildStatsBackedProviders(
  source: StatsFileSource,
  environment: ProviderEnvironment,
  options: { readonly commands?: readonly (readonly string[])[] } = {},
): readonly StatsBackedProvider[] {
  const commands = options.commands ?? []
  return [
    new StatsBackedProvider({
      id: 'workers',
      group: 'workers',
      provides: WORKER_METRICS,
      source,
      environment,
      extraProbes: commands,
    }),
    new StatsBackedProvider({
      id: 'computer-use',
      group: 'computer-use',
      provides: COMPUTER_USE_METRICS,
      source,
      environment,
      extraProbes: commands,
    }),
    new StatsBackedProvider({
      id: 'ui',
      group: 'ui',
      provides: UI_METRICS,
      source,
      environment,
      extraProbes: commands,
    }),
    new StatsBackedProvider({
      id: 'context',
      group: 'context',
      provides: CONTEXT_METRICS,
      source,
      environment,
      extraProbes: commands,
    }),
  ]
}

/** Metric groups each stats-backed provider owns, for documentation and tests. */
export const STATS_PROVIDER_METRICS: Readonly<Record<string, readonly CanonicalMetric[]>> = Object.freeze({
  workers: WORKER_METRICS,
  'computer-use': COMPUTER_USE_METRICS,
  ui: UI_METRICS,
  context: CONTEXT_METRICS,
})
