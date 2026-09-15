/**
 * Synthetic scenario harness.
 *
 * The acceptance criteria are all statements about *time*: a 30-second spike must
 * not restart anything, a 20-minute heat soak must throttle, a 4-hour memory leak
 * must raise pressure. Testing that against a wall clock is impossible, so these
 * tests drive the scheduler with an injectable clock and a fake provider set, and
 * assert on the decisions the engine reaches.
 *
 * This file is shared by the pressure, policy and acceptance suites.
 */

import { resolveConfig } from '../../lib/core/config.js'
import { HealthScheduler } from '../../lib/core/scheduler.js'

export const SECOND = 1_000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE

/** A provider whose samples a test scripts directly. */
export class ScriptedProvider {
  constructor(id, group, provides) {
    this.id = id
    this.group = group
    this.provides = provides
    this.enabled = true
    /** Values applied by the next sample, per metric. */
    this.current = {}
    /** Errors queued for upcoming samples: `true` makes the next sample reject. */
    this.failures = []
    this.samples = 0
    this.degraded = false
  }

  set(values) {
    Object.assign(this.current, values)
    return this
  }

  unset(...metrics) {
    for (const metric of metrics) delete this.current[metric]
    return this
  }

  failNext(times = 1) {
    for (let i = 0; i < times; i += 1) this.failures.push(true)
    return this
  }

  sample() {
    this.samples += 1
    if (this.failures.length > 0) {
      this.failures.shift()
      throw new Error(`scripted failure #${this.samples}`)
    }
    const metrics = {}
    for (const metric of this.provides) {
      if (metric in this.current) metrics[metric] = this.current[metric]
    }
    return {
      provider: this.id,
      timestamp: new Date(Date.now()).toISOString(),
      metrics,
      ...(this.degraded ? { degraded: true, degradedReason: 'telemetry_unavailable' } : {}),
    }
  }
}

/** Records every adapter call so a test can assert on what was requested. */
export class RecordingRestartAdapter {
  constructor(options = {}) {
    this.id = 'recording-restart'
    this.capability = options.capability ?? 'available'
    this.requests = []
    this.accept = options.accept ?? true
    this.systemAccept = options.systemAccept ?? this.accept
    this.throwOnRequest = options.throwOnRequest ?? false
  }

  async requestApplicationRestart(request) {
    this.requests.push(request)
    if (this.throwOnRequest) throw new Error('restart plugin exploded')
    return this.accept
      ? { accepted: true, state: 'queued', requestId: `r-${this.requests.length}` }
      : { accepted: false, state: 'rejected', reason: 'restart_cooldown_active' }
  }

  async requestSystemRestart(request) {
    this.requests.push(request)
    if (this.throwOnRequest) throw new Error('restart plugin exploded')
    return this.systemAccept
      ? { accepted: true, state: 'queued', requestId: `r-${this.requests.length}` }
      : { accepted: false, state: 'rejected', reason: 'system_restart_disabled' }
  }

  async cancelPendingRestart() {
    return true
  }

  get applicationRequests() {
    return this.requests.filter((request) => request.mode === 'application')
  }
}

/** Records worker-control calls. */
export class RecordingWorkerControl {
  constructor(options = {}) {
    this.id = 'recording-worker-control'
    this.capability = options.capability ?? 'available'
    this.calls = []
    this.limit = null
    this.throwOnLimit = options.throwOnLimit ?? false
  }

  async setConcurrencyLimit(limit) {
    this.calls.push(['setConcurrencyLimit', limit])
    if (this.throwOnLimit) throw new Error('worker control refused')
    this.limit = limit
  }

  async pauseNewWorkers() {
    this.calls.push(['pauseNewWorkers'])
  }

  async resumeNormalConcurrency() {
    this.calls.push(['resumeNormalConcurrency'])
    this.limit = null
  }

  currentConcurrencyLimit() {
    return this.limit
  }
}

/** A safe-point source a test can flip. */
export class ScriptedSafePoint {
  constructor(id, reading) {
    this.id = id
    this.reading = reading
    this.calls = 0
  }

  readiness() {
    this.calls += 1
    return { source: this.id, ...this.reading }
  }
}

/**
 * A scheduler driven by a fake clock.
 *
 * `advance(ms, steps)` moves the clock forward and ticks, which is how a test
 * writes "20 minutes of 88 °C" in one line.
 */
export class ScenarioRig {
  constructor(options = {}) {
    this.now = options.epoch ?? Date.parse('2026-03-01T00:00:00.000Z')
    this.config = resolveConfig(options.config ?? {})
    this.restart = options.restart ?? new RecordingRestartAdapter()
    this.workerControl = options.workerControl ?? new RecordingWorkerControl()
    this.scheduler = new HealthScheduler({
      config: this.config,
      restart: this.restart,
      workerControl: this.workerControl,
      stateDirectory: null,
      clock: () => this.now,
      ...(options.safePoints === undefined ? {} : { safePoints: options.safePoints }),
    })
    /** Every snapshot the rig has produced, oldest first. */
    this.history = []
    /** Every decision record emitted, oldest first. */
    this.decisions = []
    this.scheduler.on('decision', (record) => this.decisions.push(record))
    this.providers = []
  }

  provider(id, group, provides) {
    const provider = new ScriptedProvider(id, group, provides)
    this.scheduler.registerProvider(provider)
    this.providers.push(provider)
    return provider
  }

  /** Advance the clock by `ms` in `steps` ticks, sampling each time. */
  async advance(ms, steps = 1) {
    const stepMs = Math.round(ms / steps)
    const snapshots = []
    for (let i = 0; i < steps; i += 1) {
      this.now += stepMs
      snapshots.push(await this.scheduler.tick())
    }
    this.history.push(...snapshots)
    return snapshots
  }

  /** Run one tick without moving the clock. */
  async tick() {
    const snapshot = await this.scheduler.tick()
    this.history.push(snapshot)
    return snapshot
  }

  get last() {
    return this.history[this.history.length - 1]
  }

  get actions() {
    return this.decisions.map((record) => record.action)
  }
}

/** Convenience: the metric set of a healthy idle desktop. */
export const HEALTHY_BASELINE = Object.freeze({
  cpu_temp_c: 52,
  gpu_temp_c: 48,
  cpu_usage: 0.18,
  gpu_usage: 0.05,
  thermal_throttle: 0,
  power_limit_hit: 0,
  ram_used_ratio: 0.42,
  process_rss_bytes: 1_500_000_000,
  vram_used_ratio: 0.2,
  uptime_seconds: 4 * 3600,
  event_loop_latency_ms: 4,
  heartbeat_delay_ms: 0,
  render_latency_ms: 20,
  screenshot_latency_ms: 400,
  action_latency_ms: 120,
  timeout_rate: 0,
  failure_rate: 0,
  retry_rate: 0,
  task_latency_ms: 5_000,
})
