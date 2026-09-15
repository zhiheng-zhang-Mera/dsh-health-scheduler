/**
 * Public API of `dsh-health-scheduler`.
 *
 * This module is both the plugin entry point (it exports `name`, `inject` and
 * `apply`, which is what the Cordis loader looks for) and the library surface for
 * anyone embedding the engine directly. The engine has no dependency on the
 * harness, so importing it costs nothing and testing it needs no runtime.
 *
 * @module dsh-health-scheduler
 */

import { resolveConfig, tryResolveConfig, type ConfigOverrides } from './core/config.js'
import { HealthScheduler } from './core/scheduler.js'
import type { HealthSchedulerConfig } from './types/config.js'
import { applyHealthScheduler } from './dsh/plugin.js'

export { applyHealthScheduler }
export { HealthScheduler } from './core/scheduler.js'
export type { HealthSchedulerOptions, HealthSnapshot, SchedulerEventName, SchedulerListener } from './core/scheduler.js'
export { resolveConfig, tryResolveConfig, deepMerge, ConfigError } from './core/config.js'
export type { ConfigOverrides } from './core/config.js'
export { PRESETS, preset, PRESET_SCALES, DEFAULT_METRIC_CONFIG } from './core/presets.js'
export type { PresetName } from './core/presets.js'
export { CANONICAL_METRICS, METRICS, metricDescriptor, isCanonicalMetric } from './types/metrics.js'
export type {
  CanonicalMetric,
  MetricDescriptor,
  MetricGroup,
  MetricPolarity,
  MetricUnit,
} from './types/metrics.js'
export type {
  ActionOutcome,
  CooldownKind,
  DecisionAction,
  DecisionEvaluation,
  DecisionRecord,
  DimensionPressure,
  MachineState,
  MaintenancePhase,
  MaintenancePicture,
  MetricPressure,
  PressureDimension,
  PressureDriver,
  PressureLevel,
  PressureSnapshot,
} from './types/decision.js'
export { ACTION_LEVEL, PRESSURE_LEVEL_RANK } from './types/decision.js'
export type {
  ActionThresholds,
  AntiFlapConfig,
  CooldownConfig,
  HealthSchedulerConfig,
  HysteresisBand,
  MaintenanceConfig,
  MetricBand,
  MetricConfig,
  PressureWeights,
  ProviderOptions,
  ResilienceConfig,
  SamplingConfig,
  StorageConfig,
  ThrottleConfig,
  TrendConfig,
  WindowConfig,
} from './types/config.js'
export { DECISION_LADDER, PRESSURE_DIMENSIONS } from './types/config.js'
export type {
  DegradedReason,
  HealthProvider,
  HealthSample,
  MetricBag,
  ProviderFailure,
  ProviderStatus,
} from './types/provider.js'
export type {
  AggregatedBucket,
  GrowthProjection,
  MetricTrend,
  TrendDirection,
  WindowStats,
} from './types/window.js'
export { normalizeSample } from './core/normalize.js'
export type { NormalizationResult, NormalizationViolation } from './core/normalize.js'
export { RollingStore } from './core/rolling.js'
export type { DailyMetricSummary, DailySummary } from './core/rolling.js'
export { TrendAnalyzer, formatBytes, formatDelta, formatSlopePerHour } from './core/trend.js'
export { PressureEngine, dimensionOf, UPTIME_RAMP_FULL_MS, UPTIME_RAMP_START_MS } from './core/pressure.js'
export { LEVEL_BOUNDS, levelOf, scoreMetric, scoreWithSustain } from './core/bands.js'
export { PolicyEngine, initialPolicyState } from './core/policy.js'
export type { PolicyInput, PolicyState } from './core/policy.js'
export {
  computeMaintenancePicture,
  maintenanceAllowsRequest,
  clockWithin,
  formatClock,
  formatDuration,
  nextOccurrence,
  parseClock,
  previousOccurrence,
} from './core/maintenance.js'
export { SafePointRegistry, foldReadiness } from './core/safe-point.js'
export type {
  EstimatedState,
  MaintenanceReadiness,
  SafePointProvider,
  SafePointReading,
} from './core/safe-point.js'
export { DecisionLog, LOG_SCHEMA_VERSION } from './audit/decision-log.js'
export { ProviderRegistry } from './providers/registry.js'
export type { SamplingRound } from './providers/registry.js'
export {
  UnavailableRestartAdapter,
  UnavailableWorkerControlAdapter,
  outcomeForAction,
} from './adapters/types.js'
export type {
  CapabilityState,
  RestartAdapter,
  RestartRequest,
  RestartResponse,
  WorkerControlAdapter,
} from './adapters/types.js'
export { HardwareProvider } from './providers/hardware.js'
export { MemoryProvider } from './providers/memory.js'
export { RuntimeProvider, EMPTY_RUNTIME_FEED } from './providers/runtime.js'
export type { RuntimeFeed } from './providers/runtime.js'
export {
  StatsBackedProvider,
  buildStatsBackedProviders,
  STATS_PROVIDER_IDS,
  STATS_PROVIDER_METRICS,
} from './providers/stats-driven.js'
export { StatsFileSource, extractMetrics, parseNameValueLines, runCommandProbe, mergeBags } from './providers/sources.js'
export { defaultEnvironment, readProcessFacade } from './providers/environment.js'
export type { OsFacade, ProcessFacade, ProviderEnvironment } from './providers/environment.js'
export { metricsSnapshot, renderHealthReport } from './dsh/report.js'

/** Cordis plugin name, matched by the bundle patch row. */
export const name = 'dsh-health-scheduler'

/**
 * Services this plugin needs before it activates.
 *
 * `tools` is required because the health tools are the plugin's model-facing
 * surface. `settings` is optional in practice — the plugin registers its
 * namespace when the service is present and runs with config defaults when it is
 * not, so a profile without the settings provider still gets a working health
 * monitor.
 */
export const inject = ['tools']

/**
 * Cordis plugin entry point, called once per application load.
 *
 * @param ctx - the harness context.
 * @param config - plugin configuration; every leaf is optional and defaults to
 *   the `balanced` preset.
 */
export function apply(ctx: unknown, config: ConfigOverrides = {}): void {
  applyHealthScheduler(ctx as never, config, { resolveConfig, tryResolveConfig, createScheduler })
}

/** Construct a scheduler without starting it. Exported for embedding and tests. */
export function createScheduler(options: {
  config: HealthSchedulerConfig
  restart: import('./adapters/types.js').RestartAdapter
  workerControl: import('./adapters/types.js').WorkerControlAdapter
  stateDirectory: string | null
  clock?: () => number
}): HealthScheduler {
  return new HealthScheduler(options)
}
