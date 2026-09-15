/**
 * The decision vocabulary of `dsh-health-scheduler`: pressure levels, restart
 * pressure, action levels, machine states, and the maintenance picture.
 *
 * Everything a consumer needs to explain a decision lives in these types. A
 * decision is never "the model thought so": it is a pressure number, a state, a
 * list of named drivers, and a list of reusable evidence strings.
 *
 * @module dsh-health-scheduler/types/decision
 */

import type { CanonicalMetric } from './metrics.js'

/**
 * How much pressure one metric or one subsystem carries.
 *
 * `unknown` is a first-class level. Telemetry that is missing is *not* health:
 * a subsystem with no data must never be scored as `none`.
 */
export type PressureLevel = 'none' | 'low' | 'moderate' | 'high' | 'critical' | 'unknown'

/** Ordinal rank of a level; `unknown` ranks above `none` but is scored separately. */
export const PRESSURE_LEVEL_RANK: Readonly<Record<PressureLevel, number>> = Object.freeze({
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
  unknown: -1,
})

/** A pressure dimension: the six independent contributions to restart pressure. */
export type PressureDimension =
  | 'time'
  | 'thermal'
  | 'memory'
  | 'runtime'
  | 'worker'
  | 'computer_use_ui'

/** One metric's contribution to a dimension score. */
export interface MetricPressure {
  /** Canonical metric name. */
  readonly metric: CanonicalMetric
  /** Latest normalized value, or `null` when no data has arrived. */
  readonly value: number | null
  /** Pressure assigned to this metric, 0..100; `null` when unknown. */
  readonly score: number | null
  /** Level band of {@link MetricPressure.score}. */
  readonly level: PressureLevel
  /** Human-readable rule that produced the score, e.g. `gpu_temp_c>=86 for 900s`. */
  readonly rule: string
  /** Milliseconds the metric has continuously satisfied the rule; `0` when it does not. */
  readonly sustainedMs: number
  /** Whether a trend component contributed on top of the level component. */
  readonly trendApplied: boolean
}

/** One dimension of restart pressure. */
export interface DimensionPressure {
  /** Dimension name. */
  readonly dimension: PressureDimension
  /** Dimension score, 0..100; `null` when every metric was unknown. */
  readonly score: number | null
  /** Level band of {@link DimensionPressure.score}. */
  readonly level: PressureLevel
  /** Nominal weight of this dimension, 0..1. */
  readonly weight: number
  /** Actual weight used after renormalization over known dimensions, 0..1. */
  readonly effectiveWeight: number
  /** Per-metric detail, stable-ordered by metric name. */
  readonly metrics: readonly MetricPressure[]
  /** One-line explanation reused by the UI payload. */
  readonly summary: string
}

/** The complete pressure picture at one instant. */
export interface PressureSnapshot {
  /** ISO-8601 instant the snapshot was computed for. */
  readonly timestamp: string
  /** Weighted restart pressure, 0..100, or `null` when nothing is measurable. */
  readonly restartPressure: number | null
  /** Share of nominal weight backed by actual telemetry, 0..1. */
  readonly coverage: number
  /** Dimensions whose data was missing, stable-ordered. */
  readonly unknownDimensions: readonly PressureDimension[]
  /** Per-dimension detail, stable-ordered by dimension name. */
  readonly dimensions: readonly DimensionPressure[]
  /** Named drivers for the current pressure, ordered by contribution. */
  readonly drivers: readonly PressureDriver[]
  /** One-line primary cause, or `null` when nothing stands out. */
  readonly primaryCause: string | null
}

/** A named, explainable reason that pressure is what it is. */
export interface PressureDriver {
  /** Stable machine-readable code, e.g. `memory_slope_high`. */
  readonly code: string
  /** Dimension the driver belongs to. */
  readonly dimension: PressureDimension
  /** Contribution to restart pressure after weighting, in points. */
  readonly contribution: number
  /** Human-readable explanation with concrete numbers. */
  readonly detail: string
}

/**
 * The unified action ladder.
 *
 * The first three levels are performed by this plugin through adapters; the last
 * two are *requests* handed to `dsh-restart`, which owns the actual restart.
 */
export type DecisionAction =
  | 'NO_ACTION'
  | 'THROTTLE'
  | 'PAUSE_NEW_WORK'
  | 'REQUEST_APP_RESTART'
  | 'REQUEST_SYSTEM_REBOOT'

/** Numeric level of {@link DecisionAction}; escalation only ever increases it. */
export const ACTION_LEVEL: Readonly<Record<DecisionAction, number>> = Object.freeze({
  NO_ACTION: 0,
  THROTTLE: 1,
  PAUSE_NEW_WORK: 2,
  REQUEST_APP_RESTART: 3,
  REQUEST_SYSTEM_REBOOT: 4,
})

/**
 * Health state machine.
 *
 * ```
 * HEALTHY -> DEGRADED -> THROTTLED -> (recovered) HEALTHY
 * THROTTLED -> MAINTENANCE_PENDING -> REQUEST_APP_RESTART
 * REQUEST_APP_RESTART -> (still critical) ESCALATION_PENDING -> REQUEST_SYSTEM_REBOOT
 * ```
 */
export type MachineState =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'THROTTLED'
  | 'PAUSED'
  | 'MAINTENANCE_PENDING'
  | 'REQUEST_APP_RESTART'
  | 'ESCALATION_PENDING'
  | 'REQUEST_SYSTEM_REBOOT'
  | 'SAFE_MODE'

/** How a decision was reached. */
export interface DecisionEvaluation {
  /** Action chosen for this evaluation, before cooldown suppression. */
  readonly action: DecisionAction
  /** Action actually in force after cooldown and hysteresis. */
  readonly effectiveAction: DecisionAction
  /** State before this evaluation. */
  readonly fromState: MachineState
  /** State after this evaluation. */
  readonly toState: MachineState
  /** Restart pressure backing the decision, or `null`. */
  readonly pressure: number | null
  /** True when hysteresis held the previous action against a marginal drop. */
  readonly hysteresisHeld: boolean
  /** True when a cooldown suppressed a repeat action. */
  readonly cooldownActive: boolean
  /** Cooldown that suppressed the action, when applicable. */
  readonly cooldownKind: CooldownKind | null
  /** Milliseconds remaining on the suppressing cooldown. */
  readonly cooldownRemainingMs: number
  /** Named drivers, ordered by contribution. */
  readonly drivers: readonly PressureDriver[]
  /** Reusable evidence strings, e.g. `maintenance_window_open`. */
  readonly reasons: readonly string[]
  /** ISO-8601 instant of the evaluation. */
  readonly timestamp: string
}

/** The three independent cooldowns the scheduler enforces on itself. */
export type CooldownKind = 'throttle' | 'maintenance' | 'escalation'

/** One audit record. Every applied action produces exactly one. */
export interface DecisionRecord {
  /** Monotonic record id, unique per scheduler instance. */
  readonly id: number
  /** ISO-8601 instant the action was applied. */
  readonly timestamp: string
  /** Action that was applied. */
  readonly action: DecisionAction
  /** State after applying. */
  readonly state: MachineState
  /** Pressure backing the action, or `null`. */
  readonly pressure: number | null
  /** Coverage of the pressure snapshot, 0..1. */
  readonly coverage: number
  /** Named drivers, ordered by contribution. */
  readonly drivers: readonly PressureDriver[]
  /** Reusable evidence strings. */
  readonly reasons: readonly string[]
  /** What the action adapter reported. */
  readonly outcome: ActionOutcome
}

/** Result of trying to apply one action through its adapter. */
export interface ActionOutcome {
  /** Whether the action was carried out. */
  readonly applied: boolean
  /**
   * Adapter availability. `unavailable` means the capability is missing (for
   * example `dsh-restart` is not installed); monitoring continues regardless.
   */
  readonly capability: 'available' | 'unavailable' | 'failed'
  /** Capability that handled the action, e.g. `restart` or `worker-control`. */
  readonly adapter: string
  /** Free-form adapter detail, safe to log. */
  readonly detail: string
  /** Correlation id returned by the adapter, when it issues one. */
  readonly reference?: string
}

/** How the maintenance window stands relative to now. */
export type MaintenancePhase =
  | 'outside_window'
  | 'before_target'
  | 'at_target'
  | 'deferred'
  | 'overdue'
  | 'urgent_override'

/** The maintenance picture at one instant, without applying pressure to it. */
export interface MaintenancePicture {
  /** Phase of the window relative to now. */
  readonly phase: MaintenancePhase
  /** Whether `now` is inside the allowed window. */
  readonly windowOpen: boolean
  /** ISO-8601 instant of the upcoming target, or `null` when disabled. */
  readonly nextTargetAt: string | null
  /** Milliseconds until the window closes; `0` once it has. */
  readonly windowClosesInMs: number
  /** Milliseconds the target has been deferred so far. */
  readonly deferredMs: number
  /** Whether the configured max defer has been exhausted. */
  readonly deferExhausted: boolean
  /** Whether an urgent override is in force. */
  readonly urgentOverride: boolean
  /** One-line explanation for the UI payload. */
  readonly summary: string
}
