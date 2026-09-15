/**
 * Configuration surface of `dsh-health-scheduler`.
 *
 * Every number in here is a default, never a law. The plugin ships three presets
 * (`conservative`, `balanced`, `aggressive`) that are complete documents of this
 * shape, and a user can override any leaf through the plugin's own settings
 * namespace or through a profile patch.
 *
 * @module dsh-health-scheduler/types/config
 */

import type { CanonicalMetric } from './metrics.js'
import type { DecisionAction, PressureDimension } from './decision.js'

/** A `[enter, exit]` pair. Hysteresis requires `exit < enter`. */
export interface HysteresisBand {
  /** Pressure at or above which the level is entered. */
  readonly enter: number
  /** Pressure at or below which the level is left again. */
  readonly exit: number
}

/** Where one metric's pressure ramp starts and saturates. */
export interface MetricBand {
  /**
   * Value at which this metric starts contributing pressure.
   * For a `lower-is-worse` metric this is the *higher* of the two numbers.
   */
  readonly warn: number
  /**
   * Value at which this metric contributes a full 100.
   * For a `lower-is-worse` metric this is the *lower* of the two numbers.
   */
  readonly critical: number
}

/** Per-metric scoring configuration. */
export interface MetricConfig {
  /** Ramp endpoints. Omitted means the metric is collected but never scored. */
  readonly band?: MetricBand
  /** Weight of this metric inside its dimension. Defaults to `1`. */
  readonly weight?: number
  /**
   * Milliseconds the metric must stay in a band before its level counts.
   * This is the "86 °C for 15 minutes" rule from the design: a spike does not
   * raise pressure, a sustained condition does.
   */
  readonly sustainMs?: number
  /** Points added per hour of upward trend, capped by {@link MetricConfig.trendCap}. */
  readonly trendPointsPerHour?: number
  /** Maximum trend contribution for this metric. Defaults to `25`. */
  readonly trendCap?: number
}

/** The six dimension weights of the restart-pressure model. */
export interface PressureWeights {
  time: number
  thermal: number
  memory: number
  runtime: number
  worker: number
  computer_use_ui: number
}

/** Action ladder thresholds with hysteresis. */
export interface ActionThresholds {
  throttle: HysteresisBand
  pause_new_work: HysteresisBand
  request_app_restart: HysteresisBand
  request_system_reboot: HysteresisBand
}

/** Self-imposed cooldowns, in milliseconds. */
export interface CooldownConfig {
  throttleMs: number
  maintenanceMs: number
  escalationMs: number
}

/** What the THROTTLE action actually asks for. */
export interface ThrottleConfig {
  /**
   * Worker concurrency the THROTTLE action asks the harness to adopt. `null`
   * leaves the harness's own configured limit in place and only pauses new
   * admission, which is the right choice when the plugin does not know what the
   * normal limit is.
   */
  readonly concurrencyLimit: number | null
  /**
   * Fraction by which the *observed* active worker count is reduced when
   * {@link ThrottleConfig.concurrencyLimit} is `null` and a limit must still be
   * derived. Bounded below by 1.
   */
  readonly concurrencyFactor: number
}

/** Provider collection cadence. */
export interface SamplingConfig {
  /** Milliseconds between scheduler ticks. */
  readonly intervalMs: number
  /** Milliseconds between trend evaluations; the cheap path in between. */
  readonly trendIntervalMs: number
  /** Milliseconds between persistence flushes. */
  readonly persistIntervalMs: number
  /** Backoff applied after the first provider failure, in milliseconds. */
  readonly providerBackoffMs: number
  /** Upper bound of the exponential provider backoff, in milliseconds. */
  readonly providerBackoffMaxMs: number
}

/** Rolling window definitions. */
export interface WindowConfig {
  /**
   * Minimum retention horizon for raw samples, in milliseconds (30 minutes by
   * default). The effective retention is `max(rawMs, longest statistics window)`
   * so a longer statistics window is always fully backed by samples.
   */
  readonly rawMs: number
  /** Windows kept for statistics, in milliseconds. */
  readonly windowsMs: readonly number[]
  /** Aggregated bucket size for long-horizon history, in milliseconds. */
  readonly aggregateBucketMs: number
  /** How long aggregates are retained, in milliseconds. Default 24 h. */
  readonly aggregateRetentionMs: number
  /** How long daily summaries are retained, in milliseconds. Default 14 days. */
  readonly dailyRetentionMs: number
}

/** Memory- and trend-specific tuning. */
export interface TrendConfig {
  /** Minimum samples before a slope is reported at all. */
  readonly minSamples: number
  /** Minimum span in milliseconds before a slope is reported. */
  readonly minSpanMs: number
  /** Minimum R² for a slope to be trusted as a trend. */
  readonly minRSquared: number
}

/** Maintenance window configuration. */
export interface MaintenanceConfig {
  /** Whether scheduled maintenance is armed at all. */
  readonly enabled: boolean
  /** Local wall-clock target, `HH:MM`, 24-hour. */
  readonly targetTime: string
  /** Local wall-clock start of the allowed window, `HH:MM`. */
  readonly windowStart: string
  /** Local wall-clock end of the allowed window, `HH:MM`. */
  readonly windowEnd: string
  /** Maximum deferral past the target, in milliseconds. */
  readonly maxDeferMs: number
  /**
   * Pressure at or above which the window is ignored and maintenance becomes
   * urgent. `null` disables the override.
   */
  readonly urgentOverridePressure: number | null
  /** Whether a maintenance restart request may be raised at all. */
  readonly allowAppRestart: boolean
  /**
   * Capability ids that must be reported safe by `getMaintenanceReadiness()`
   * before a restart request is raised inside the window.
   */
  readonly safePointRequired: boolean
}

/** Anti-flapping and re-request configuration. */
export interface AntiFlapConfig {
  /** Minimum milliseconds in a state before another transition is allowed. */
  readonly minStateDwellMs: number
  /** Minimum milliseconds between two identical applied actions. */
  readonly minRepeatActionMs: number
  /**
   * Consecutive evaluations a condition must hold before it is actionable.
   * `1` disables debounce.
   */
  readonly debounceEvaluations: number
}

/** Failure isolation and adapter tuning. */
export interface ResilienceConfig {
  /** Consecutive provider failures before the provider is disabled temporarily. */
  readonly providerFailureLimit: number
  /** Whether a failing provider is retried after a backoff. */
  readonly providerRetryAfterBackoff: boolean
  /** Whether an unavailable action adapter marks its capability degraded. */
  readonly reportDegradedCapability: boolean
}

/** Persistence bounds. Keeping this plugin out of the observability business. */
export interface StorageConfig {
  /** Whether anything is written to disk. */
  readonly enabled: boolean
  /** Directory override; defaults to `<DSH_HOME>/health-scheduler`. */
  readonly directory: string | null
  /** Maximum bytes of the rolling JSONL decision log. */
  readonly maxLogBytes: number
  /** Maximum number of decision records kept in memory for the UI. */
  readonly maxRecentDecisions: number
}

/** The complete plugin configuration. */
export interface HealthSchedulerConfig {
  /** Master switch. When false the plugin loads but collects nothing. */
  readonly enabled: boolean
  /**
   * Selects the shipped preset the configuration is based on. Explicit values
   * below always win over the preset.
   */
  readonly preset: 'conservative' | 'balanced' | 'aggressive' | 'custom'
  readonly sampling: SamplingConfig
  readonly windows: WindowConfig
  readonly trend: TrendConfig
  readonly weights: PressureWeights
  readonly thresholds: ActionThresholds
  readonly metrics: Partial<Record<CanonicalMetric, MetricConfig>>
  readonly cooldowns: CooldownConfig
  readonly throttle: ThrottleConfig
  readonly maintenance: MaintenanceConfig
  readonly antiFlap: AntiFlapConfig
  readonly resilience: ResilienceConfig
  readonly storage: StorageConfig
  /** Provider ids to disable, e.g. `["hardware"]` on a machine with no sensors. */
  readonly disabledProviders: readonly string[]
  /** Optional external commands per CPU-temperature fallback, etc. */
  readonly providerOptions: ProviderOptions
}

/** Per-provider options for the built-in providers. */
export interface ProviderOptions {
  /** Hardware provider options. */
  readonly hardware: {
    /** Metric names that should be treated as unavailable even if a sensor exists. */
    readonly ignoreMetrics: readonly CanonicalMetric[]
    /**
     * Thermal-zone paths to read on Linux, or a Windows helper executable that
     * prints `name,value` lines on stdout.
     */
    readonly helperCommand: readonly string[] | null
    /** Milliseconds a helper command may run before it is abandoned. */
    readonly helperTimeoutMs: number
  }
  /** Memory provider options. */
  readonly memory: {
    /** Process ids to include in the process-tree memory sums. */
    readonly extraPids: readonly number[]
  }
  /** Runtime provider options. */
  readonly runtime: {
    /**
     * Heartbeat file the host writes on every event-loop turn. When set, the
     * runtime provider reports `heartbeat_delay_ms` from its mtime.
     */
    readonly heartbeatFile: string | null
    /** Expected heartbeat cadence, in milliseconds. */
    readonly heartbeatExpectedMs: number
  }
  /** Computer-use provider options. */
  readonly computerUse: {
    /** Whether the probe runs on the plugin's own tick. */
    readonly probeOnTick: boolean
    /** Milliseconds a probe may take before it is counted as a stall. */
    readonly probeTimeoutMs: number
  }
  /** Options for the three stats-file-backed providers. */
  readonly statsFile: {
    /**
     * Paths the host or an integration writes canonical metrics into, newest
     * write wins. Any provider whose metrics are absent from the file simply
     * reports nothing, which is scored as unknown — never as healthy.
     */
    readonly paths: readonly string[]
    /** Milliseconds after which a file's contents are treated as stale. */
    readonly staleAfterMs: number
    /** Extra command probes: `name,value` lines on stdout mapped to metrics. */
    readonly commands: readonly CommandProbeConfig[]
  }
}

/** One external command whose stdout carries metric readings. */
export interface CommandProbeConfig {
  /** Command and arguments, executed without a shell. */
  readonly argv: readonly string[]
  /** Milliseconds the command may run before it is abandoned. */
  readonly timeoutMs: number
  /**
   * Lines `metric_name=value` or `metric_name,value`; any other line is ignored.
   * Names must be canonical metric names.
   */
  readonly format: 'name-value'
}

/** The action a satisfied threshold produces. */
export const DECISION_LADDER: readonly DecisionAction[] = Object.freeze([
  'NO_ACTION',
  'THROTTLE',
  'PAUSE_NEW_WORK',
  'REQUEST_APP_RESTART',
  'REQUEST_SYSTEM_REBOOT',
])

/** Dimensions in their canonical presentation order. */
export const PRESSURE_DIMENSIONS: readonly PressureDimension[] = Object.freeze([
  'time',
  'thermal',
  'memory',
  'runtime',
  'worker',
  'computer_use_ui',
])
