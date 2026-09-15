/**
 * Shipped configuration presets.
 *
 * The presets are ordinary config documents. They are exported from the package
 * as JSON under `presets/` so an operator can diff them, and they are reachable
 * at runtime through `resolveConfig({ preset: 'aggressive' })`.
 *
 * @module dsh-health-scheduler/core/presets
 */

import type { HealthSchedulerConfig, MetricConfig } from '../types/config.js'
import { METRICS, type CanonicalMetric } from '../types/metrics.js'

/**
 * How each preset scales the balanced document.
 *
 * `bands` moves the whole ladder: conservative acts sooner (0.85), aggressive
 * later (1.15). Both the `enter` and the `exit` of every band are scaled by the
 * same factor, so a preset preserves the width of each hysteresis band in
 * relative terms rather than flattening it. `cooldown` and `maintenance` scale
 * the pacing knobs the same way.
 */
export const PRESET_SCALES = Object.freeze({
  conservative: { bands: 0.85, cooldown: 1.5, maintenance: 0.85 },
  balanced: { bands: 1, cooldown: 1, maintenance: 1 },
  aggressive: { bands: 1.15, cooldown: 0.7, maintenance: 1.3 },
})

/** Which preset names exist. */
export type PresetName = 'conservative' | 'balanced' | 'aggressive'

const HOUR = 3_600_000
const MINUTE = 60_000

/** The neutral metric table: every scoreable metric with its balanced band. */
export const DEFAULT_METRIC_CONFIG: Readonly<Partial<Record<CanonicalMetric, MetricConfig>>> =
  Object.freeze({
    cpu_temp_c: { band: { warn: 80, critical: 95 }, sustainMs: 60_000, trendPointsPerHour: 30, trendCap: 20 },
    gpu_temp_c: { band: { warn: 78, critical: 92 }, sustainMs: 60_000, trendPointsPerHour: 30, trendCap: 20 },
    cpu_usage: { band: { warn: 0.7, critical: 0.98 }, sustainMs: 300_000 },
    gpu_usage: { band: { warn: 0.7, critical: 0.98 }, sustainMs: 300_000 },
    thermal_throttle: { band: { warn: 0.01, critical: 0.5 }, sustainMs: 30_000, weight: 2 },
    power_limit_hit: { band: { warn: 0.05, critical: 0.6 }, sustainMs: 60_000, weight: 1.5 },

    ram_used_ratio: { band: { warn: 0.8, critical: 0.96 }, sustainMs: 120_000 },
    commit_used_ratio: { band: { warn: 0.8, critical: 0.96 }, sustainMs: 120_000, weight: 0.8 },
    ram_available_bytes: { band: { warn: 4 * 1024 ** 3, critical: 512 * 1024 ** 2 }, sustainMs: 120_000, weight: 0.5 },
    // Growth is the memory signal that matters: no band, only a trend term.
    // These two carry double weight inside the dimension so a 500 MB/h leak is
    // not averaged away by a calm `ram_used_ratio`.
    process_rss_bytes: { trendPointsPerHour: 60, trendCap: 60, weight: 2 },
    process_private_bytes: { trendPointsPerHour: 60, trendCap: 60, weight: 2 },
    vram_used_ratio: { band: { warn: 0.85, critical: 0.98 }, sustainMs: 120_000 },

    uptime_seconds: { trendPointsPerHour: 0, trendCap: 0, weight: 1 },
    event_loop_latency_ms: { band: { warn: 50, critical: 400 }, sustainMs: 60_000, trendPointsPerHour: 40, trendCap: 20 },
    heartbeat_delay_ms: { band: { warn: 5_000, critical: 30_000 }, sustainMs: 60_000 },
    ipc_timeout_rate: { band: { warn: 0.01, critical: 0.1 }, sustainMs: 60_000 },
    handle_count: { trendPointsPerHour: 8, trendCap: 15, weight: 0.6 },
    thread_count: { trendPointsPerHour: 8, trendCap: 15, weight: 0.6 },
    restart_count: { band: { warn: 2, critical: 6 }, sustainMs: 0, weight: 0.5 },

    timeout_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 60_000, weight: 1.2 },
    failure_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 60_000, weight: 1.2 },
    retry_rate: { band: { warn: 0.1, critical: 0.5 }, sustainMs: 60_000 },
    spawn_failure_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 60_000 },
    abnormal_exit_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 60_000 },
    queue_delay_ms: { band: { warn: 15_000, critical: 120_000 }, sustainMs: 60_000 },
    queued_tasks: { band: { warn: 20, critical: 200 }, sustainMs: 120_000, weight: 0.5 },
    active_workers: { weight: 0.25 },
    task_latency_ms: { band: { warn: 30_000, critical: 180_000 }, sustainMs: 120_000, trendPointsPerHour: 30, trendCap: 20 },

    screenshot_latency_ms: { band: { warn: 2_000, critical: 8_000 }, sustainMs: 60_000, trendPointsPerHour: 60, trendCap: 25 },
    action_latency_ms: { band: { warn: 1_000, critical: 5_000 }, sustainMs: 60_000, trendPointsPerHour: 60, trendCap: 25 },
    verification_retry_rate: { band: { warn: 0.1, critical: 0.5 }, sustainMs: 60_000 },
    missed_target_rate: { band: { warn: 0.05, critical: 0.3 }, sustainMs: 60_000 },
    recovery_rate: { band: { warn: 0.8, critical: 0.3 }, sustainMs: 120_000 },
    desktop_responsiveness_ms: { band: { warn: 500, critical: 3_000 }, sustainMs: 60_000, trendPointsPerHour: 60, trendCap: 25 },

    render_latency_ms: { band: { warn: 250, critical: 2_000 }, sustainMs: 60_000, trendPointsPerHour: 60, trendCap: 25 },
    main_window_heartbeat_ms: { band: { warn: 2_000, critical: 10_000 }, sustainMs: 60_000 },
    blank_frame_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 60_000 },
    frontend_error_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 60_000 },

    task_failure_rate: { band: { warn: 0.05, critical: 0.3 }, sustainMs: 120_000, weight: 0.5 },
    git_operations_per_minute: { weight: 0.5 },
  })

/** The balanced (default) preset. */
export const BALANCED_PRESET: HealthSchedulerConfig = Object.freeze({
  enabled: true,
  preset: 'balanced',

  sampling: {
    intervalMs: 15_000,
    trendIntervalMs: 60_000,
    persistIntervalMs: 300_000,
    providerBackoffMs: 30_000,
    providerBackoffMaxMs: 600_000,
  },

  windows: {
    rawMs: 30 * MINUTE,
    windowsMs: [5 * MINUTE, 30 * MINUTE, 2 * HOUR, 6 * HOUR],
    aggregateBucketMs: 5 * MINUTE,
    aggregateRetentionMs: 24 * HOUR,
    dailyRetentionMs: 14 * 24 * HOUR,
  },

  trend: {
    minSamples: 3,
    minSpanMs: 5 * MINUTE,
    minRSquared: 0.5,
  },

  weights: {
    time: 0.15,
    thermal: 0.2,
    memory: 0.25,
    runtime: 0.15,
    worker: 0.15,
    computer_use_ui: 0.1,
  },

  thresholds: {
    throttle: { enter: 55, exit: 45 },
    pause_new_work: { enter: 70, exit: 60 },
    request_app_restart: { enter: 80, exit: 68 },
    request_system_reboot: { enter: 95, exit: 85 },
  },

  metrics: DEFAULT_METRIC_CONFIG,

  cooldowns: {
    throttleMs: 5 * MINUTE,
    maintenanceMs: 30 * MINUTE,
    escalationMs: 60 * MINUTE,
  },

  throttle: {
    concurrencyLimit: null,
    concurrencyFactor: 0.5,
  },

  maintenance: {
    enabled: false,
    targetTime: '04:00',
    windowStart: '03:30',
    windowEnd: '05:00',
    maxDeferMs: 60 * MINUTE,
    urgentOverridePressure: 92,
    allowAppRestart: true,
    safePointRequired: true,
  },

  antiFlap: {
    minStateDwellMs: 2 * MINUTE,
    minRepeatActionMs: 10 * MINUTE,
    debounceEvaluations: 2,
  },

  resilience: {
    providerFailureLimit: 3,
    providerRetryAfterBackoff: true,
    reportDegradedCapability: true,
  },

  storage: {
    enabled: true,
    directory: null,
    maxLogBytes: 4 * 1024 * 1024,
    maxRecentDecisions: 50,
  },

  disabledProviders: [],

  providerOptions: {
    hardware: { ignoreMetrics: [], helperCommand: null, helperTimeoutMs: 5_000 },
    memory: { extraPids: [] },
    runtime: { heartbeatFile: null, heartbeatExpectedMs: 15_000 },
    computerUse: { probeOnTick: false, probeTimeoutMs: 2_000 },
    statsFile: { paths: [], staleAfterMs: 120_000, commands: [] },
  },
})

/** A deep-ish clone helper good enough for this pure-JSON config document. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Build a preset by scaling the balanced document. */
function scalePreset(
  name: PresetName,
  options: {
    readonly bands: number
    readonly maintenance: number
    readonly cooldown: number
  },
): HealthSchedulerConfig {
  const base = clone(BALANCED_PRESET)
  // Entries are capped at 99 so a scaled ladder stays reachable: a preset that
  // pushes a level past 100 would silently remove that level from the ladder.
  const enter = (value: number): number => Math.min(99, Math.round(value * options.bands))
  const exit = (value: number): number => Math.max(1, Math.min(99, Math.round(value * options.bands)))
  const scaled: HealthSchedulerConfig = {
    ...base,
    preset: name,
    thresholds: {
      throttle: {
        enter: enter(BALANCED_PRESET.thresholds.throttle.enter),
        exit: exit(BALANCED_PRESET.thresholds.throttle.exit),
      },
      pause_new_work: {
        enter: enter(BALANCED_PRESET.thresholds.pause_new_work.enter),
        exit: exit(BALANCED_PRESET.thresholds.pause_new_work.exit),
      },
      request_app_restart: {
        enter: enter(BALANCED_PRESET.thresholds.request_app_restart.enter),
        exit: exit(BALANCED_PRESET.thresholds.request_app_restart.exit),
      },
      request_system_reboot: {
        enter: enter(BALANCED_PRESET.thresholds.request_system_reboot.enter),
        exit: exit(BALANCED_PRESET.thresholds.request_system_reboot.exit),
      },
    },
    cooldowns: {
      throttleMs: Math.round(BALANCED_PRESET.cooldowns.throttleMs * options.cooldown),
      maintenanceMs: Math.round(BALANCED_PRESET.cooldowns.maintenanceMs * options.cooldown),
      escalationMs: Math.round(BALANCED_PRESET.cooldowns.escalationMs * options.cooldown),
    },
    maintenance: {
      ...base.maintenance,
      maxDeferMs: Math.round(BALANCED_PRESET.maintenance.maxDeferMs * options.maintenance),
      urgentOverridePressure:
        BALANCED_PRESET.maintenance.urgentOverridePressure === null
          ? null
          : Math.round(BALANCED_PRESET.maintenance.urgentOverridePressure / options.bands),
    },
    antiFlap: {
      ...base.antiFlap,
      minStateDwellMs: Math.round(BALANCED_PRESET.antiFlap.minStateDwellMs * options.maintenance),
      minRepeatActionMs: Math.round(BALANCED_PRESET.antiFlap.minRepeatActionMs * options.maintenance),
    },
  }
  return Object.freeze(scaled)
}

const CONSERVATIVE = scalePreset('conservative', {
  bands: PRESET_SCALES.conservative.bands,
  maintenance: PRESET_SCALES.conservative.maintenance,
  cooldown: PRESET_SCALES.conservative.cooldown,
})

const AGGRESSIVE = scalePreset('aggressive', {
  bands: PRESET_SCALES.aggressive.bands,
  maintenance: PRESET_SCALES.aggressive.maintenance,
  cooldown: PRESET_SCALES.aggressive.cooldown,
})

/** All shipped presets by name. */
export const PRESETS: Readonly<Record<PresetName, HealthSchedulerConfig>> = Object.freeze({
  conservative: CONSERVATIVE,
  balanced: BALANCED_PRESET,
  aggressive: AGGRESSIVE,
})

/** Fetch a preset by name, falling back to `balanced`. */
export function preset(name: string | undefined): HealthSchedulerConfig {
  if (name === 'conservative') return CONSERVATIVE
  if (name === 'aggressive') return AGGRESSIVE
  return BALANCED_PRESET
}

/** Metric names that carry a scoreable band in the default table. */
export const DEFAULT_SCORED_METRICS: readonly CanonicalMetric[] = Object.freeze(
  (Object.keys(DEFAULT_METRIC_CONFIG) as CanonicalMetric[]).filter(
    (name) => DEFAULT_METRIC_CONFIG[name]?.band !== undefined,
  ),
)

/** Metric names in the canonical registry that have no band and no trend. */
export const DEFAULT_UNSCORED_METRICS: readonly CanonicalMetric[] = Object.freeze(
  (Object.keys(METRICS) as CanonicalMetric[]).filter(
    (name) => DEFAULT_METRIC_CONFIG[name] === undefined,
  ),
)
