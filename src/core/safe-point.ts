/**
 * Safe points.
 *
 * The scheduler asks "is now a good moment?" and does not store the answer. Task
 * state, checkpoints and resume belong to DS-Hns Core; this module only relays
 * the question to whoever is authoritative and folds their answers together.
 *
 * The one rule that matters: an unanswered question is not a `yes`. When no
 * source is registered, or a source is silent, the registry reports
 * {@link SafePointReading.safe} as `null` — unknown — and a configuration that
 * requires a safe point treats unknown as "not safe".
 *
 * @module dsh-health-scheduler/core/safe-point
 */

/** How busy the system looks right now. */
export type EstimatedState = 'idle' | 'busy' | 'critical' | 'unknown'

/** One source's answer to `getMaintenanceReadiness()`. */
export interface SafePointReading {
  /** Source id. */
  readonly source: string
  /** `true` safe, `false` unsafe, `null` unknown. */
  readonly safe: boolean | null
  /** Machine-readable reason code, e.g. `git_commit_in_progress`. */
  readonly reason: string
  /** The source's own estimate of how busy it is. */
  readonly estimatedState: EstimatedState
  /** Free-form detail, safe to log. */
  readonly detail?: string
}

/** What a safe-point source must implement. */
export interface SafePointProvider {
  /** Stable unique source id. */
  readonly id: string
  /**
   * Answer the readiness question. May reject; a rejection is contained and the
   * source is reported `unknown` for that tick.
   */
  readiness(): Promise<SafePointReading> | SafePointReading
}

/** The folded answer over every registered source. */
export interface MaintenanceReadiness {
  /**
   * `true` when every source says safe, `false` when any source says unsafe,
   * `null` when no source answered.
   */
  readonly safe: boolean | null
  /** Reason code of the deciding source, or `no_safe_point_source`. */
  readonly reason: string
  /** Worst state any source reported. */
  readonly estimated_state: EstimatedState
  /** Per-source detail, stable-ordered by source id. */
  readonly sources: readonly SafePointReading[]
  /** One-line explanation for the UI payload and the audit log. */
  readonly summary: string
}

/** Rank of a state; higher is busier. */
const STATE_RANK: Readonly<Record<EstimatedState, number>> = Object.freeze({
  idle: 0,
  busy: 1,
  critical: 2,
  unknown: 3,
})

/** Fold readings into one answer, worst-first. */
export function foldReadiness(readings: readonly SafePointReading[]): MaintenanceReadiness {
  if (readings.length === 0) {
    return {
      safe: null,
      reason: 'no_safe_point_source',
      estimated_state: 'unknown',
      sources: [],
      summary: 'no safe-point source registered; readiness unknown',
    }
  }

  const sorted = [...readings].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
  const unsafe = sorted.find((reading) => reading.safe === false)
  const worst = sorted.reduce(
    (acc, reading) => (STATE_RANK[reading.estimatedState] > STATE_RANK[acc] ? reading.estimatedState : acc),
    'idle' as EstimatedState,
  )

  if (unsafe !== undefined) {
    return {
      safe: false,
      reason: unsafe.reason,
      estimated_state: worst,
      sources: sorted,
      summary: `unsafe: ${unsafe.source} reports ${unsafe.reason}`,
    }
  }

  const unknown = sorted.find((reading) => reading.safe === null)
  if (unknown !== undefined) {
    return {
      safe: null,
      reason: unknown.reason,
      estimated_state: 'unknown',
      sources: sorted,
      summary: `unknown: ${unknown.source} reports ${unknown.reason}`,
    }
  }

  return {
    safe: true,
    reason: 'safe_point_reached',
    estimated_state: worst,
    sources: sorted,
    summary: sorted.map((reading) => `${reading.source}:safe(${reading.reason})`).join(', '),
  }
}

/**
 * A registry of safe-point sources.
 *
 * Sources are registered by adapters (DS-Hns Core bridge, the restart plugin's
 * checkpoint gate, a test double). A source that throws is contained: it
 * contributes an `unknown` reading, and the scheduler keeps monitoring.
 */
export class SafePointRegistry {
  private readonly providers = new Map<string, SafePointProvider>()

  /** Register a source. Returns a disposer. */
  register(provider: SafePointProvider): () => void {
    this.providers.set(provider.id, provider)
    return () => {
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id)
    }
  }

  /** Registered source ids, sorted. */
  sources(): readonly string[] {
    return [...this.providers.keys()].sort()
  }

  /** Whether any source is registered at all. */
  get isEmpty(): boolean {
    return this.providers.size === 0
  }

  /**
   * Ask every source, containing failures.
   *
   * @param timeoutMs - per-source budget; a source that overruns is reported
   *   unknown and does not delay the tick.
   */
  async readiness(timeoutMs = 1_000): Promise<MaintenanceReadiness> {
    if (this.providers.size === 0) return foldReadiness([])
    const entries = [...this.providers.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const readings = await Promise.all(entries.map((provider) => this.ask(provider, timeoutMs)))
    return foldReadiness(readings)
  }

  private async ask(provider: SafePointProvider, timeoutMs: number): Promise<SafePointReading> {
    let timer: NodeJS.Timeout | undefined
    try {
      const result = await Promise.race([
        Promise.resolve(provider.readiness()),
        new Promise<SafePointReading>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                source: provider.id,
                safe: null,
                reason: 'safe_point_timeout',
                estimatedState: 'unknown',
                detail: `no answer within ${timeoutMs} ms`,
              }),
            timeoutMs,
          )
        }),
      ])
      return result
    } catch (error) {
      return {
        source: provider.id,
        safe: null,
        reason: 'safe_point_source_failed',
        estimatedState: 'unknown',
        detail: (error as Error).message,
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
