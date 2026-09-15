/**
 * Runtime provider: uptime, handle/thread counts, event-loop and heartbeat delay.
 *
 * Uptime and handle counts are measured directly. Event-loop latency is measured
 * by the plugin's own sampler rather than derived here, so this provider accepts
 * an injected reading. Heartbeat delay comes from a heartbeat file the host
 * touches on every event-loop turn: the provider compares its mtime against the
 * expected cadence and reports the lateness. When no heartbeat file is
 * configured, the metric is absent — again, not zero.
 *
 * @module dsh-health-scheduler/providers/runtime
 */

import { existsSync, statSync } from 'node:fs'
import type { ProviderOptions } from '../types/config.js'
import type { CanonicalMetric } from '../types/metrics.js'
import type { HealthProvider, HealthSample } from '../types/provider.js'
import type { ProviderEnvironment } from './environment.js'

const PROVIDES: readonly CanonicalMetric[] = [
  'event_loop_latency_ms',
  'handle_count',
  'heartbeat_delay_ms',
  'ipc_timeout_rate',
  'restart_count',
  'thread_count',
  'uptime_seconds',
  'worker_process_count',
]

/** Values this provider cannot measure itself and accepts from the host. */
export interface RuntimeFeed {
  /** Latest event-loop delay measurement, in milliseconds. */
  eventLoopLatencyMs(): number | null
  /** Live worker process count, when the host can count them. */
  workerProcessCount(): number | null
  /** Thread count of the process tree, when the host can count it. */
  threadCount(): number | null
  /** Restart count reported by the supervisor, when present. */
  restartCount(): number | null
  /** IPC timeout rate, when an IPC layer reports it. */
  ipcTimeoutRate(): number | null
}

/** A feed that answers `null` to everything: the honest default. */
export const EMPTY_RUNTIME_FEED: RuntimeFeed = Object.freeze({
  eventLoopLatencyMs: () => null,
  workerProcessCount: () => null,
  threadCount: () => null,
  restartCount: () => null,
  ipcTimeoutRate: () => null,
})

/** Reads runtime health from the process itself plus an injected feed. */
export class RuntimeProvider implements HealthProvider {
  readonly id = 'runtime'
  readonly group = 'runtime' as const
  readonly provides = PROVIDES
  readonly enabled = true

  private readonly environment: ProviderEnvironment
  private readonly options: ProviderOptions['runtime']
  private readonly feed: RuntimeFeed
  private lastHeartbeatSeenAt: number | null = null

  constructor(environment: ProviderEnvironment, options: ProviderOptions['runtime'], feed: RuntimeFeed) {
    this.environment = environment
    this.options = options
    this.feed = feed
  }

  sample(): HealthSample {
    const nowMs = this.environment.clock()
    const timestamp = new Date(nowMs).toISOString()
    const metrics: Record<string, number> = {}
    const notes: string[] = []

    metrics.uptime_seconds = this.environment.process.uptimeSeconds
    const handles = this.environment.process.activeHandles
    if (handles !== null) metrics.handle_count = handles
    else notes.push('active resource counts unavailable in this runtime')

    const eventLoop = this.feed.eventLoopLatencyMs()
    if (eventLoop !== null) metrics.event_loop_latency_ms = eventLoop
    else notes.push('no event-loop latency sampler bound')

    const workers = this.feed.workerProcessCount()
    if (workers !== null) metrics.worker_process_count = workers

    const threads = this.feed.threadCount()
    if (threads !== null) metrics.thread_count = threads

    const restarts = this.feed.restartCount()
    if (restarts !== null) metrics.restart_count = restarts

    const ipc = this.feed.ipcTimeoutRate()
    if (ipc !== null) metrics.ipc_timeout_rate = ipc

    const heartbeat = this.heartbeatDelayMs(nowMs)
    if (heartbeat !== null) metrics.heartbeat_delay_ms = heartbeat
    else if (this.options.heartbeatFile !== null) {
      notes.push(`heartbeat file ${this.options.heartbeatFile} not readable yet`)
    }

    const missing = PROVIDES.filter((metric) => metrics[metric] === undefined)
    const degraded = missing.length > 0

    return {
      provider: this.id,
      timestamp,
      metrics,
      ...(degraded ? { degraded: true } : {}),
      ...(degraded ? { degradedReason: 'telemetry_unavailable' as const } : {}),
      note:
        notes.length > 0
          ? notes.join('; ')
          : 'all runtime metrics measured',
    }
  }

  /**
   * Heartbeat lateness: how much older the heartbeat file is than the expected
   * cadence. A file that is exactly on time reports 0; a file that has stopped
   * being touched reports its full age, which is what makes a frozen UI visible.
   */
  private heartbeatDelayMs(nowMs: number): number | null {
    const file = this.options.heartbeatFile
    if (file === null) return null
    if (!existsSync(file)) return null
    try {
      const mtimeMs = statSync(file).mtimeMs
      this.lastHeartbeatSeenAt = mtimeMs
      return Math.max(0, nowMs - mtimeMs - this.options.heartbeatExpectedMs)
    } catch {
      return null
    }
  }

  /** Last observed heartbeat instant, for the UI payload. */
  get heartbeatSeenAt(): number | null {
    return this.lastHeartbeatSeenAt
  }
}
