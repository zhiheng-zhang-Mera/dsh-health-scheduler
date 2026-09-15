/**
 * Harness integration: the plugin's `apply` body.
 *
 * Responsibilities, in order:
 *
 * 1. Resolve configuration (bundle config, then the plugin's settings namespace)
 *    and never throw out of `apply` because of a bad user document.
 * 2. Build the engine, the providers and both adapters.
 * 3. Register the model-facing tools.
 * 4. Start the loop, and stop it when the plugin is disposed.
 *
 * A failure anywhere in here degrades the plugin, never the host: the design's
 * last acceptance criterion is that uninstalling this plugin does not affect
 * DS-Hns, and the same holds while it is installed and misconfigured.
 *
 * @module dsh-health-scheduler/dsh/plugin
 */

import type { ConfigOverrides, ConfigError } from '../core/config.js'
import type { HealthSchedulerConfig } from '../types/config.js'
import { CANONICAL_METRICS, isCanonicalMetric } from '../types/metrics.js'
import { HealthScheduler, type HealthSnapshot } from '../core/scheduler.js'
import { renderHealthReport } from './report.js'
import { loggerOf, type HarnessContextLike, type ToolDefinitionLike } from './context.js'
import {
  UnavailableRestartAdapter,
  UnavailableWorkerControlAdapter,
  type RestartAdapter,
  type WorkerControlAdapter,
} from '../adapters/types.js'
import { defaultEnvironment, type ProviderEnvironment } from '../providers/environment.js'
import { HardwareProvider } from '../providers/hardware.js'
import { MemoryProvider } from '../providers/memory.js'
import { RuntimeProvider, EMPTY_RUNTIME_FEED, type RuntimeFeed } from '../providers/runtime.js'
import { buildStatsBackedProviders } from '../providers/stats-driven.js'
import { ProcessTreeReader } from '../providers/process-tree.js'
import { StatsFileSource } from '../providers/sources.js'

/** Collaborators injected by the package entry point, so this module stays testable. */
export interface PluginDependencies {
  resolveConfig(overrides: ConfigOverrides): HealthSchedulerConfig
  tryResolveConfig(overrides: ConfigOverrides): { config: HealthSchedulerConfig; error: ConfigError | null }
  createScheduler(options: {
    config: HealthSchedulerConfig
    restart: RestartAdapter
    workerControl: WorkerControlAdapter
    stateDirectory: string | null
    clock?: () => number
  }): HealthScheduler
}

/** Settings namespace owned by this plugin. */
export const SETTINGS_NAMESPACE = 'health-scheduler'

/** Tool names registered for the model. */
export const TOOL_NAMES = Object.freeze({
  status: 'health_status',
  history: 'health_history',
  policy: 'health_policy',
})

/** Everything the plugin wired up, returned for tests and for diagnostics. */
export interface AppliedHealthScheduler {
  readonly scheduler: HealthScheduler
  readonly config: HealthSchedulerConfig
  readonly providerIds: readonly string[]
  readonly toolNames: readonly string[]
  dispose(): void
}

/** Options for {@link applyHealthScheduler}, for tests. */
export interface ApplyOptions {
  /** Override the provider environment. */
  readonly environment?: ProviderEnvironment
  /** Override the adapters. */
  readonly restart?: RestartAdapter
  /** Override the worker-control adapter. */
  readonly workerControl?: WorkerControlAdapter
  /** Override the runtime feed. */
  readonly runtimeFeed?: RuntimeFeed
  /** Directory for the decision log; `null` disables persistence. */
  readonly stateDirectory?: string | null
  /** Injectable clock. */
  readonly clock?: () => number
  /** Start the periodic loop. Defaults to `true`. */
  readonly start?: boolean
}

/**
 * Wire the plugin into a harness context.
 *
 * @param ctx - harness context (structurally typed in `./context.ts`).
 * @param overrides - bundle configuration.
 * @param deps - engine collaborators from the package entry point.
 * @param options - test seams.
 * @returns the applied plugin handle.
 */
export function applyHealthScheduler(
  ctx: HarnessContextLike,
  overrides: ConfigOverrides = {},
  deps: PluginDependencies,
  options: ApplyOptions = {},
): AppliedHealthScheduler {
  const log = loggerOf(ctx)
  const { config, error } = deps.tryResolveConfig(overrides)
  if (error !== null) {
    log.error(
      `health-scheduler: configuration was rejected (${error.message}); continuing with the balanced preset. ` +
        'Fix the offending value and reload the profile to activate it.',
    )
  }

  const environment = options.environment ?? defaultEnvironment({ stateDirectory: options.stateDirectory ?? null })
  const scheduler = deps.createScheduler({
    config,
    restart: options.restart ?? restartAdapterFrom(ctx),
    workerControl: options.workerControl ?? new UnavailableWorkerControlAdapter(),
    stateDirectory: options.stateDirectory ?? environment.stateDirectory,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  })

  const providerIds = registerBuiltInProviders(scheduler, config, environment, options)

  const settingScope = registerSettings(ctx, config, deps, scheduler, log)
  void settingScope

  const toolNames = ctx.tools === undefined ? [] : registerTools(ctx, scheduler, log)
  if (ctx.tools === undefined) {
    log.warn(
      'health-scheduler: no tool runtime in this profile; health data is available through the plugin API only',
    )
  }

  if (config.enabled && options.start !== false) {
    scheduler.start()
    log.info(
      `health-scheduler: monitoring started (${providerIds.length} providers, interval ${config.sampling.intervalMs} ms, preset ${config.preset})`,
    )
  } else if (!config.enabled) {
    log.info('health-scheduler: disabled by configuration; no sampling is running')
  }

  const dispose = (): void => {
    scheduler.stop()
    log.info('health-scheduler: monitoring stopped')
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose)

  return { scheduler, config, providerIds, toolNames, dispose }
}

/** Register the built-in providers that this configuration enables. */
function registerBuiltInProviders(
  scheduler: HealthScheduler,
  config: HealthSchedulerConfig,
  environment: ProviderEnvironment,
  options: ApplyOptions,
): readonly string[] {
  const ids: string[] = []
  const disabled = new Set(config.disabledProviders)

  if (!disabled.has('hardware')) {
    scheduler.registerProvider(
      new HardwareProvider(environment, config.providerOptions.hardware),
    )
    ids.push('hardware')
  }
  if (!disabled.has('memory')) {
    scheduler.registerProvider(
      new MemoryProvider(
        environment,
        config.providerOptions.memory,
        {
          command: config.providerOptions.hardware.helperCommand,
          timeoutMs: config.providerOptions.hardware.helperTimeoutMs,
        },
        config.providerOptions.memory.extraPids.length === 0
          ? null
          : new ProcessTreeReader({
              extraPids: config.providerOptions.memory.extraPids,
              refreshMs: config.sampling.intervalMs * 2,
            }),
      ),
    )
    ids.push('memory')
  }
  if (!disabled.has('runtime')) {
    scheduler.registerProvider(
      new RuntimeProvider(environment, config.providerOptions.runtime, options.runtimeFeed ?? EMPTY_RUNTIME_FEED),
    )
    ids.push('runtime')
  }

  const source = new StatsFileSource(
    config.providerOptions.statsFile.paths,
    config.providerOptions.statsFile.staleAfterMs,
  )
  for (const provider of buildStatsBackedProviders(source, environment, {
    commands: config.providerOptions.statsFile.commands.map((command) => command.argv),
  })) {
    if (disabled.has(provider.id)) continue
    scheduler.registerProvider(provider)
    ids.push(provider.id)
  }

  return ids
}

/**
 * Resolve the restart adapter.
 *
 * Order of preference: an adapter published by `dsh-restart` on the context,
 * then the built-in unavailable adapter. There is deliberately no third option —
 * this plugin has no way to restart anything by itself.
 */
function restartAdapterFrom(ctx: HarnessContextLike): RestartAdapter {
  const candidate = ctx.healthScheduler
  if (isRestartAdapter(candidate)) return candidate
  return new UnavailableRestartAdapter()
}

/** Structural check for a restart adapter published by another plugin. */
function isRestartAdapter(value: unknown): value is RestartAdapter {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RestartAdapter>
  return (
    typeof candidate.requestApplicationRestart === 'function' &&
    typeof candidate.requestSystemRestart === 'function' &&
    typeof candidate.capability === 'string'
  )
}

/** Register the settings namespace, when the profile has a settings service. */
function registerSettings(
  ctx: HarnessContextLike,
  config: HealthSchedulerConfig,
  deps: PluginDependencies,
  scheduler: HealthScheduler,
  log: ReturnType<typeof loggerOf>,
): { get(): HealthSchedulerConfig } | null {
  if (ctx.settings === undefined) {
    log.warn(
      'health-scheduler: no settings service in this profile; configuration comes from the bundle patch only',
    )
    return null
  }
  try {
    const scope = ctx.settings.register<HealthSchedulerConfig>(
      SETTINGS_NAMESPACE,
      configSchema(),
      { base: config, applies: 'live' },
    )
    if (typeof scope.watch === 'function') {
      scope.watch((next) => {
        try {
          scheduler.reconfigure(deps.resolveConfig(next as ConfigOverrides))
          log.info('health-scheduler: configuration updated from settings')
        } catch (error) {
          log.error(`health-scheduler: rejected settings update: ${(error as Error).message}`)
        }
      })
    }
    return scope
  } catch (error) {
    log.error(`health-scheduler: settings registration failed: ${(error as Error).message}`)
    return null
  }
}

/**
 * The settings schema.
 *
 * The declarative shape is what the harness renders in its settings UI; the
 * authoritative validation remains `resolveConfig`, which the watch callback
 * runs on every change. Keeping both means a value the UI accepts but the engine
 * cannot act on is rejected loudly instead of silently applied.
 */
function configSchema(): Record<string, unknown> {
  const fields: Record<string, { type: string; description: string }> = {
    enabled: { type: 'boolean', description: 'Master switch for sampling and actions.' },
    preset: {
      type: 'string',
      description: 'Base preset: conservative, balanced, aggressive or custom.',
    },
  }
  return { type: 'object', properties: fields, additionalProperties: true }
}

/** Register the three health tools. */
function registerTools(
  ctx: HarnessContextLike,
  scheduler: HealthScheduler,
  log: ReturnType<typeof loggerOf>,
): readonly string[] {
  const tools = ctx.tools
  if (tools === undefined) return []
  const disposers: Array<() => void> = []

  const status = tool({
    name: TOOL_NAMES.status,
    description:
      'Report the current health of the DS-Hns runtime: restart pressure 0-100, machine state, per-dimension scores, ' +
      'named drivers, maintenance window status and which capabilities are available. ' +
      'This tool only reads; it never restarts, throttles or changes anything. ' +
      'Metrics that could not be measured are reported as unknown — unknown is never treated as healthy.',
    parameters: {
      section: {
        type: 'string',
        required: false,
        enum: ['full', 'pressure', 'maintenance', 'providers'],
        description: 'Limit the report to one section. Defaults to full.',
      },
    },
    execute: async (args: { section?: string }) => {
      const snapshot = scheduler.snapshot ?? (await scheduler.tick())
      const section = args.section ?? 'full'
      if (section === 'full') return renderHealthReport(snapshot)
      if (section === 'pressure') return renderPressureSection(snapshot)
      if (section === 'maintenance') return renderMaintenanceSection(snapshot)
      return renderProviderSection(snapshot)
    },
  })

  const history = tool({
    name: TOOL_NAMES.history,
    description:
      'Return rolling-window statistics (mean, p95, max, slope per hour, R², consecutive threshold duration) for one ' +
      'canonical metric. Use this to decide whether a condition is a spike or a sustained trend. ' +
      `Canonical metric names: ${CANONICAL_METRICS.join(', ')}.`,
    parameters: {
      metric: {
        type: 'string',
        required: true,
        description: 'Canonical metric name, for example gpu_temp_c or process_rss_bytes.',
      },
      window_minutes: {
        type: 'number',
        required: false,
        description: 'Restrict the output to windows at or below this size, in minutes.',
      },
    },
    execute: async (args: { metric: string; window_minutes?: number }) => {
      if (!isCanonicalMetric(args.metric)) {
        throw new Error(
          `health_history: unknown metric "${args.metric}". Canonical names: ${CANONICAL_METRICS.join(', ')}`,
        )
      }
      const stats = scheduler.windowsFor(args.metric)
      const filtered =
        args.window_minutes === undefined
          ? stats
          : stats.filter((entry) => entry.windowMs <= args.window_minutes! * 60_000)
      return JSON.stringify(
        {
          metric: args.metric,
          windows: filtered.map((entry) => ({
            window_minutes: Math.round(entry.windowMs / 60_000),
            count: entry.count,
            mean: entry.mean,
            p95: entry.p95,
            max: entry.max,
            latest: entry.latest,
            slope_per_hour: entry.slopePerHour,
            r_squared: entry.rSquared,
            consecutive_ms: entry.consecutiveMs,
            span_ms: entry.spanMs,
          })),
        },
        null,
        2,
      )
    },
  })

  const policy = tool({
    name: TOOL_NAMES.policy,
    description:
      'Explain the decision policy: the action ladder thresholds with their hysteresis exit bands, the dimension weights, ' +
      'the maintenance window rules, the cooldowns, and the reason codes attached to the most recent decisions. ' +
      'Read-only; no capability is exercised.',
    parameters: {
      action: {
        type: 'string',
        required: false,
        enum: ['explain', 'config', 'decisions'],
        description: 'explain returns how the ladder works, config returns the resolved numbers, decisions returns the audit trail.',
      },
    },
    execute: async (args: { action?: string }) => {
      const action = args.action ?? 'explain'
      const config = scheduler.config
      if (action === 'config') {
        return JSON.stringify(
          {
            preset: config.preset,
            thresholds: config.thresholds,
            weights: config.weights,
            cooldowns: config.cooldowns,
            anti_flap: config.antiFlap,
            maintenance: config.maintenance,
            windows_ms: config.windows.windowsMs,
            sampling: config.sampling,
          },
          null,
          2,
        )
      }
      if (action === 'decisions') {
        return JSON.stringify(scheduler.decisions(20), null, 2)
      }
      return [
        'Action ladder (enter/exit pressure):',
        `  1 THROTTLE              enter >= ${config.thresholds.throttle.enter}, exit <= ${config.thresholds.throttle.exit}`,
        `  2 PAUSE_NEW_WORK        enter >= ${config.thresholds.pause_new_work.enter}, exit <= ${config.thresholds.pause_new_work.exit}`,
        `  3 REQUEST_APP_RESTART   enter >= ${config.thresholds.request_app_restart.enter}, exit <= ${config.thresholds.request_app_restart.exit}`,
        `  4 REQUEST_SYSTEM_REBOOT enter >= ${config.thresholds.request_system_reboot.enter}, exit <= ${config.thresholds.request_system_reboot.exit}`,
        '',
        'Levels 1 and 2 are applied by this plugin through the worker-control adapter.',
        'Levels 3 and 4 are *requests* handed to dsh-restart, which owns restart execution.',
        'A restart request is additionally gated by the maintenance window and by getMaintenanceReadiness().',
        '',
        `Dimension weights: ${Object.entries(config.weights)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')}`,
        'Weights are renormalized over the dimensions that actually have telemetry; the fraction that does is reported as coverage.',
      ].join('\n')
    },
  })

  for (const definition of [status, history, policy]) {
    try {
      disposers.push(tools.register(definition))
    } catch (error) {
      log.error(`health-scheduler: tool registration failed for ${definition.name}: ${(error as Error).message}`)
    }
  }

  return [TOOL_NAMES.status, TOOL_NAMES.history, TOOL_NAMES.policy].slice(0, disposers.length)
}

/** Build a tool definition that satisfies the harness contract. */
function tool(spec: {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: never) => Promise<string>
}): ToolDefinitionLike {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
    },
    execute: spec.execute as ToolDefinitionLike['execute'],
    timeoutMs: 10_000,
  }
}

function renderPressureSection(snapshot: HealthSnapshot): string {
  const lines = [
    `Restart Pressure: ${snapshot.pressure === null ? 'unknown' : `${snapshot.pressure} / 100`}`,
    `State: ${snapshot.state}`,
    `Coverage: ${Math.round(snapshot.coverage * 100)}%`,
    `Primary cause: ${snapshot.primaryCause ?? 'none'}`,
  ]
  for (const driver of snapshot.drivers) {
    lines.push(`  [${driver.contribution.toFixed(1)}] ${driver.code}: ${driver.detail}`)
  }
  return lines.join('\n')
}

function renderMaintenanceSection(snapshot: HealthSnapshot): string {
  return [
    `Maintenance phase: ${snapshot.maintenance.phase}`,
    `Window open: ${snapshot.maintenance.windowOpen}`,
    `Next target: ${snapshot.maintenance.nextTargetAt ?? 'not scheduled'}`,
    `Deferred: ${Math.round(snapshot.maintenance.deferredMs / 1000)}s`,
    `Safe point: ${snapshot.readiness.summary}`,
    `Restart capability: ${snapshot.capabilities.restart}`,
  ].join('\n')
}

function renderProviderSection(snapshot: HealthSnapshot): string {
  return snapshot.providers
    .map(
      (provider) =>
        `${provider.id}: ${provider.available ? 'available' : 'unavailable'} ` +
        `(successes=${provider.totalSuccesses}, failures=${provider.totalFailures}, ` +
        `backoff=${Math.round(provider.backoffRemainingMs / 1000)}s)` +
        (provider.lastError === null ? '' : ` — ${provider.lastError}`),
    )
    .join('\n')
}
