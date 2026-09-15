/**
 * The provider registry.
 *
 * Failure isolation lives here. One telemetry source that hangs, throws or
 * disappears must not stop the other five, and it must not turn the plugin into a
 * spin loop. So a failing provider gets a consecutive-failure count and an
 * exponential backoff, and every tick reports which providers were skipped and
 * why.
 *
 * @module dsh-health-scheduler/providers/registry
 */

import type { HealthProvider, HealthSample, ProviderFailure, ProviderStatus } from '../types/provider.js'
import type { ResilienceConfig, SamplingConfig } from '../types/config.js'

interface Entry {
  provider: HealthProvider
  consecutiveFailures: number
  totalFailures: number
  totalSuccesses: number
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastError: string | null
  disabledUntil: number
}

/** Result of one sampling round. */
export interface SamplingRound {
  /** Samples that succeeded, in provider id order. */
  readonly samples: readonly HealthSample[]
  /** Failures observed this round. */
  readonly failures: readonly ProviderFailure[]
  /** Providers skipped because their backoff had not expired. */
  readonly skipped: readonly string[]
}

/** Categorised provider failures handed to the scheduler's observer. */
export type ProviderFailureListener = (failure: ProviderFailure) => void

/**
 * A registry of health providers with per-provider circuit breaking.
 */
export class ProviderRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly sampling: SamplingConfig
  private readonly resilience: ResilienceConfig
  private readonly disabled: ReadonlySet<string>
  private readonly listeners = new Set<ProviderFailureListener>()

  constructor(options: {
    sampling: SamplingConfig
    resilience: ResilienceConfig
    disabledProviders: readonly string[]
  }) {
    this.sampling = options.sampling
    this.resilience = options.resilience
    this.disabled = new Set(options.disabledProviders)
  }

  /** Register a provider. Returns a disposer that removes it again. */
  register(provider: HealthProvider): () => void {
    if (this.entries.has(provider.id)) {
      throw new Error(`health-scheduler: provider "${provider.id}" is already registered`)
    }
    this.entries.set(provider.id, {
      provider,
      consecutiveFailures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      disabledUntil: 0,
    })
    return () => {
      this.entries.delete(provider.id)
    }
  }

  /** Observe provider failures, e.g. to write them into the audit log. */
  onFailure(listener: ProviderFailureListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Registered provider ids, sorted. */
  ids(): readonly string[] {
    return [...this.entries.keys()].sort()
  }

  /** Whether a provider id is registered. */
  has(id: string): boolean {
    return this.entries.has(id)
  }

  /** Current status of every provider, sorted by id. */
  status(nowMs: number): readonly ProviderStatus[] {
    return [...this.entries.values()]
      .map((entry): ProviderStatus => ({
        id: entry.provider.id,
        group: entry.provider.group,
        consecutiveFailures: entry.consecutiveFailures,
        totalFailures: entry.totalFailures,
        totalSuccesses: entry.totalSuccesses,
        lastSuccessAt: entry.lastSuccessAt,
        lastFailureAt: entry.lastFailureAt,
        lastError: entry.lastError,
        backoffRemainingMs: Math.max(0, entry.disabledUntil - nowMs),
        available: this.isAvailable(entry, nowMs),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /**
   * Sample every available provider once, containing every failure.
   *
   * Providers run concurrently; one slow source delays the round but cannot
   * corrupt it. The caller is expected to hold a per-tick budget of its own if
   * needed — this method never rejects.
   */
  async sampleAll(nowMs: number, timestamp: string): Promise<SamplingRound> {
    const samples: HealthSample[] = []
    const failures: ProviderFailure[] = []
    const skipped: string[] = []

    const runnable: Entry[] = []
    for (const entry of [...this.entries.values()].sort((a, b) => (a.provider.id < b.provider.id ? -1 : 1))) {
      if (!this.isAvailable(entry, nowMs)) {
        skipped.push(entry.provider.id)
        continue
      }
      runnable.push(entry)
    }

    const results = await Promise.all(
      runnable.map(async (entry) => {
        try {
          const sample = await entry.provider.sample()
          return { entry, sample, error: null as Error | null }
        } catch (error) {
          return { entry, sample: null, error: error as Error }
        }
      }),
    )

    for (const result of results) {
      const { entry } = result
      if (result.error !== null) {
        entry.consecutiveFailures += 1
        entry.totalFailures += 1
        entry.lastFailureAt = timestamp
        entry.lastError = truncate(result.error.message, 400)
        const backoffMs = this.backoffFor(entry)
        entry.disabledUntil = nowMs + backoffMs
        const failure: ProviderFailure = {
          provider: entry.provider.id,
          message: entry.lastError,
          consecutiveFailures: entry.consecutiveFailures,
          backoffMs,
          timestamp,
        }
        failures.push(failure)
        for (const listener of this.listeners) {
          try {
            listener(failure)
          } catch {
            // A listener must never break sampling.
          }
        }
        continue
      }

      const sample = result.sample as HealthSample
      entry.consecutiveFailures = 0
      entry.totalSuccesses += 1
      entry.lastSuccessAt = timestamp
      entry.lastError = null
      entry.disabledUntil = 0
      samples.push(sample)
    }

    return { samples, failures, skipped }
  }

  /** Reset all backoff windows, e.g. after a user-visible settings change. */
  resetBackoff(): void {
    for (const entry of this.entries.values()) {
      entry.disabledUntil = 0
      entry.consecutiveFailures = 0
    }
  }

  private isAvailable(entry: Entry, nowMs: number): boolean {
    if (this.disabled.has(entry.provider.id)) return false
    if (entry.provider.enabled === false) return false
    if (!this.resilience.providerRetryAfterBackoff && entry.consecutiveFailures > 0) return false
    return entry.disabledUntil <= nowMs
  }

  private backoffFor(entry: Entry): number {
    if (entry.consecutiveFailures < this.resilience.providerFailureLimit) return 0
    const steps = entry.consecutiveFailures - this.resilience.providerFailureLimit
    const raw = this.sampling.providerBackoffMs * 2 ** Math.min(steps, 8)
    return Math.min(raw, this.sampling.providerBackoffMaxMs)
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
