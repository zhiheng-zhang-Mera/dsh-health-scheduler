/**
 * Action adapters.
 *
 * This plugin decides; it does not act on the operating system. Every action that
 * leaves the process goes through an adapter, which is the only place allowed to
 * know how the capability is reached:
 *
 * - {@link RestartAdapter} talks to the `dsh-restart` bundle when it is installed.
 *   When it is not, the capability is reported `unavailable` and monitoring
 *   continues unchanged.
 * - {@link WorkerControlAdapter} asks the harness to lower its own concurrency.
 *   It never touches worker internals.
 *
 * @module dsh-health-scheduler/adapters
 */

import type { ActionOutcome } from '../types/decision.js'

/** Whether a capability can currently be used. */
export type CapabilityState = 'available' | 'unavailable' | 'failed'

/** A restart request handed to `dsh-restart`. */
export interface RestartRequest {
  /** Caller-chosen unique id; the restart side de-duplicates on it. */
  readonly requestId: string
  /** Requesting module id. */
  readonly source: string
  /** Restart scope. */
  readonly mode: 'application' | 'system'
  /** Stable reason code, e.g. `RUNTIME_PRESSURE`. */
  readonly reasonCode: string
  /** One-line human summary; the restart side does not parse it. */
  readonly reasonSummary: string
  /** Whether a checkpoint must succeed before the restart proceeds. */
  readonly checkpointRequired: boolean
  /** Priority hint. */
  readonly priority: 'low' | 'normal' | 'high' | 'emergency'
}

/** The restart side's answer. */
export interface RestartResponse {
  /** Whether the request was accepted. */
  readonly accepted: boolean
  /** Lifecycle state of the request. */
  readonly state:
    | 'rejected'
    | 'queued'
    | 'checkpointing'
    | 'restarting'
    | 'verifying'
    | 'completed'
    | 'failed'
  /** Rejection reason, when `accepted` is false. */
  readonly reason?: string
  /** The restart side's own correlation id, when it issues one. */
  readonly requestId?: string
}

/** What a restart capability must implement. */
export interface RestartAdapter {
  /** Stable adapter id, used in audit records. */
  readonly id: string
  /** Whether the capability is usable right now. */
  readonly capability: CapabilityState
  /** Ask for an application-scope restart. */
  requestApplicationRestart(request: RestartRequest): Promise<RestartResponse>
  /** Ask for a machine-scope restart. Only called when explicitly enabled. */
  requestSystemRestart(request: RestartRequest): Promise<RestartResponse>
  /** Ask the restart side to abandon a pending request. */
  cancelPendingRestart(requestId: string): Promise<boolean>
}

/** What a worker-control capability must implement. */
export interface WorkerControlAdapter {
  /** Stable adapter id, used in audit records. */
  readonly id: string
  /** Whether the capability is usable right now. */
  readonly capability: CapabilityState
  /** Cap the number of concurrently running workers. */
  setConcurrencyLimit(limit: number): Promise<void>
  /** Stop admitting new work. */
  pauseNewWorkers(): Promise<void>
  /** Return to the configured normal concurrency. */
  resumeNormalConcurrency(): Promise<void>
  /** Current effective concurrency limit, when known. */
  currentConcurrencyLimit(): number | null
}

/**
 * A restart adapter that always reports `unavailable`.
 *
 * This is what the scheduler uses when `dsh-restart` is not installed. It exists
 * so that "restart is impossible" is a normal, well-typed outcome rather than a
 * `null` check scattered through the decision path.
 */
export class UnavailableRestartAdapter implements RestartAdapter {
  readonly id = 'restart-unavailable'
  readonly capability: CapabilityState = 'unavailable'
  /** Why the capability is unavailable, surfaced in audit records. */
  readonly reason: string

  constructor(reason = 'dsh-restart is not installed in this profile') {
    this.reason = reason
  }

  requestApplicationRestart(): Promise<RestartResponse> {
    return Promise.resolve({ accepted: false, state: 'rejected', reason: this.reason })
  }

  requestSystemRestart(): Promise<RestartResponse> {
    return Promise.resolve({ accepted: false, state: 'rejected', reason: this.reason })
  }

  cancelPendingRestart(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

/** A worker-control adapter that reports `unavailable`. */
export class UnavailableWorkerControlAdapter implements WorkerControlAdapter {
  readonly id = 'worker-control-unavailable'
  readonly capability: CapabilityState = 'unavailable'
  /** Why the capability is unavailable, surfaced in audit records. */
  readonly reason: string

  constructor(reason = 'no harness worker-control service is bound in this profile') {
    this.reason = reason
  }

  setConcurrencyLimit(): Promise<void> {
    return Promise.resolve()
  }

  pauseNewWorkers(): Promise<void> {
    return Promise.resolve()
  }

  resumeNormalConcurrency(): Promise<void> {
    return Promise.resolve()
  }

  currentConcurrencyLimit(): number | null {
    return null
  }
}

/** Build the audit outcome for one adapter call. */
export function outcomeForAction(outcome: {
  applied: boolean
  adapter: string
  detail: string
  reference?: string
}): ActionOutcome {
  return {
    applied: outcome.applied,
    capability: outcome.applied ? 'available' : 'failed',
    adapter: outcome.adapter,
    detail: outcome.detail,
    ...(outcome.reference === undefined ? {} : { reference: outcome.reference }),
  }
}
