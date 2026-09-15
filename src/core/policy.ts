/**
 * The policy engine.
 *
 * This is the part that answers "what should happen now?" — and it is
 * deliberately boring. It reads a pressure number and a maintenance picture,
 * applies hysteresis, debounce, dwell and cooldown rules, and emits at most one
 * action. It never touches a process, a queue or a device.
 *
 * Anti-flapping is not optional. Without it, `55 -> throttle, 54 -> normal,
 * 56 -> throttle` turns a healthy machine into a machine that is constantly
 * being adjusted.
 *
 * @module dsh-health-scheduler/core/policy
 */

import { ACTION_LEVEL, type DecisionAction, type DecisionEvaluation, type MachineState } from '../types/decision.js'
import type { HealthSchedulerConfig, HysteresisBand } from '../types/config.js'
import type { PressureSnapshot } from '../types/decision.js'
import type { MaintenancePicture } from '../types/decision.js'
import type { MaintenanceReadiness } from './safe-point.js'

/** Everything the policy engine needs to reach a decision. */
export interface PolicyInput {
  /** Current pressure picture. */
  readonly pressure: PressureSnapshot
  /** Current maintenance picture. */
  readonly maintenance: MaintenancePicture
  /**
   * Folded safe-point answer. `null` means "do not ask" (a configuration that
   * does not require a safe point).
   */
  readonly readiness: MaintenanceReadiness | null
  /** Whether the restart adapter can currently accept a request. */
  readonly restartCapability: 'available' | 'unavailable' | 'failed'
  /** Whether the worker-control adapter can currently apply throttle actions. */
  readonly workerControlCapability: 'available' | 'unavailable' | 'failed'
  /** Evaluation instant, epoch milliseconds. */
  readonly nowMs: number
  /** ISO-8601 form of {@link PolicyInput.nowMs}. */
  readonly timestamp: string
  /**
   * What the scheduler actually did last time.
   *
   * The policy engine deliberately does not keep this itself: only the scheduler
   * knows whether an adapter was really invoked and what it answered, and a
   * cooldown that starts on a decision nobody carried out is a cooldown that
   * blocks the very action it was meant to pace.
   */
  readonly attempts: ActionAttempts
}

/** Cooldown bucket an action belongs to. */
export type CooldownKind = 'throttle' | 'maintenance' | 'escalation'

/** What the scheduler has actually attempted, and until when each bucket rests. */
export interface ActionAttempts {
  /** When the last action was really attempted. */
  readonly lastAttemptAt: number
  /** Which action that was. */
  readonly lastAttemptAction: DecisionAction
  /** Earliest instant at which each cooldown bucket may be used again. */
  readonly cooldowns: Readonly<Record<CooldownKind, number>>
}

/** Cooldown bucket a decision action belongs to. */
export function cooldownKindOf(action: DecisionAction): CooldownKind {
  switch (action) {
    case 'THROTTLE':
    case 'PAUSE_NEW_WORK':
      return 'throttle'
    case 'REQUEST_APP_RESTART':
      return 'maintenance'
    default:
      return 'escalation'
  }
}

/** State a decision left behind, fed back into the next evaluation. */
export interface PolicyState {
  readonly action: DecisionAction
  readonly state: MachineState
  readonly sinceMs: number
  readonly lastPressure: number | null
  readonly consecutiveCandidate: number
  readonly candidate: DecisionAction
}

/** A fresh policy state: healthy, nothing cooling down. */
export function initialPolicyState(nowMs: number): PolicyState {
  return {
    action: 'NO_ACTION',
    state: 'HEALTHY',
    sinceMs: nowMs,
    lastPressure: null,
    consecutiveCandidate: 0,
    candidate: 'NO_ACTION',
  }
}

/** A fresh attempt log: nothing attempted, nothing cooling down. */
export function initialActionAttempts(): ActionAttempts {
  return {
    lastAttemptAt: 0,
    lastAttemptAction: 'NO_ACTION',
    cooldowns: { throttle: 0, maintenance: 0, escalation: 0 },
  }
}

/** Why an action was chosen, kept for the audit record. */
interface Candidate {
  readonly action: DecisionAction
  readonly reasons: readonly string[]
}

/**
 * Content-free of side effects: given inputs and previous state, produce a
 * decision and the next state.
 */
export class PolicyEngine {
  private readonly config: HealthSchedulerConfig

  constructor(config: HealthSchedulerConfig) {
    this.config = config
  }

  /**
   * Evaluate one tick.
   *
   * @param input - pressure, maintenance, capabilities and clock.
   * @param previous - the state returned by the previous evaluation.
   * @returns the decision and the state to pass into the next evaluation.
   */
  evaluate(input: PolicyInput, previous: PolicyState): { decision: DecisionEvaluation; state: PolicyState } {
    const { thresholds, antiFlap } = this.config
    const pressure = input.pressure.restartPressure
    const ladder: ReadonlyArray<readonly [DecisionAction, HysteresisBand]> = [
      ['REQUEST_SYSTEM_REBOOT', thresholds.request_system_reboot],
      ['REQUEST_APP_RESTART', thresholds.request_app_restart],
      ['PAUSE_NEW_WORK', thresholds.pause_new_work],
      ['THROTTLE', thresholds.throttle],
    ]

    let candidate: Candidate = { action: 'NO_ACTION', reasons: ['pressure_below_all_thresholds'] }
    for (const [action, band] of ladder) {
      if (pressure !== null && pressure >= band.enter) {
        candidate = this.buildCandidate(action, input, band.enter)
        break
      }
    }

    // Hysteresis: an active action is only released once pressure falls through
    // its own exit band. Without this the system oscillates around the threshold.
    const activeLevel = ACTION_LEVEL[previous.action]
    let hysteresisHeld = false
    if (activeLevel > 0 && candidate.action === 'NO_ACTION' && pressure !== null) {
      const activeBand = ladder.find(([action]) => action === previous.action)?.[1]
      if (activeBand !== undefined && pressure > activeBand.exit) {
        hysteresisHeld = true
        candidate = { action: previous.action, reasons: ['hysteresis_holds_active_action'] }
      }
    }

    // Debounce: a *new* high-risk level must persist for N evaluations before it
    // is acted on. The counter tracks the raw candidate for this tick, not the
    // action in force, so a candidate that keeps repeating while nothing has been
    // applied yet still accumulates.
    let consecutiveCandidate: number
    if (candidate.action === previous.candidate) {
      consecutiveCandidate = previous.consecutiveCandidate + (candidate.action === previous.action ? 0 : 1)
    } else {
      consecutiveCandidate = 1
    }

    let effective = candidate
    if (
      ACTION_LEVEL[candidate.action] > activeLevel &&
      ACTION_LEVEL[candidate.action] >= ACTION_LEVEL.REQUEST_APP_RESTART &&
      antiFlap.debounceEvaluations > 1 &&
      consecutiveCandidate < antiFlap.debounceEvaluations
    ) {
      effective = {
        action: previous.action,
        reasons: [
          ...candidate.reasons,
          `debounce_${candidate.action.toLowerCase()}_${consecutiveCandidate}_of_${antiFlap.debounceEvaluations}`,
        ],
      }
    }

    // Dwell: a real fix is never delayed. Dwell paces *adjustments* between
    // levels that have already been applied, so leaving THROTTLE for a calmer
    // level, or stepping from one active mitigation to another, waits out the
    // configured minimum. It never blocks the first crossing out of NO_ACTION:
    // "do nothing for two minutes even though we are overheating" is not a safe
    // default, and a critical escalation is exempt as well.
    let dwellHeld = false
    const dwellElapsed = input.nowMs - previous.sinceMs
    const adjustingAnActiveLevel = ACTION_LEVEL[previous.action] > 0
    if (
      adjustingAnActiveLevel &&
      effective.action !== previous.action &&
      ACTION_LEVEL[effective.action] < ACTION_LEVEL.REQUEST_APP_RESTART &&
      dwellElapsed < antiFlap.minStateDwellMs
    ) {
      dwellHeld = true
      effective = {
        action: previous.action,
        reasons: [
          ...effective.reasons,
          `state_dwell_${Math.round(dwellElapsed / 1000)}s_of_${Math.round(antiFlap.minStateDwellMs / 1000)}s`,
        ],
      }
    }

    // Maintenance: a restart is a request, not a right. Pressure can be past the
    // threshold while the window, the safe point, or the configuration says no.
    if (effective.action === 'REQUEST_APP_RESTART' || effective.action === 'REQUEST_SYSTEM_REBOOT') {
      const gate = this.gateRestart(effective.action, input)
      effective = {
        action: gate.blocked ? gate.downgradeTo : effective.action,
        reasons: [...effective.reasons, ...gate.reasons],
      }
    }

    // Cooldown: never repeat the same action sooner than the configuration allows.
    // Note the asymmetry: a suppressed *repeat* suppresses the action, while a
    // suppressed *de-escalation* is simply delayed. Recovery is never blocked.
    let cooldownActive = false
    let cooldownKind: CooldownKind | null = null
    let cooldownRemainingMs = 0
    let repeatSuppressed = false
    if (effective.action !== 'NO_ACTION') {
      const kind = cooldownKindOf(effective.action)
      const until = input.attempts.cooldowns[kind]
      const sinceAttempt = input.nowMs - input.attempts.lastAttemptAt
      const sameAsLastAttempt = input.attempts.lastAttemptAction === effective.action
      const mergedReasons = [...effective.reasons]
      if (until > input.nowMs) {
        // A running cooldown for this bucket either suppresses a repeat of the
        // action already in force, or merely delays a *different* level that
        // shares the bucket. It never blocks the first crossing of a level the
        // scheduler has not attempted at all.
        cooldownActive = true
        cooldownKind = kind
        cooldownRemainingMs = until - input.nowMs
        repeatSuppressed = effective.action === previous.action && sameAsLastAttempt
        mergedReasons.push(repeatSuppressed ? `${kind}_cooldown_active` : `${kind}_cooldown_delays_transition`)
      } else if (sameAsLastAttempt && sinceAttempt < antiFlap.minRepeatActionMs) {
        cooldownActive = true
        cooldownKind = kind
        cooldownRemainingMs = antiFlap.minRepeatActionMs - sinceAttempt
        repeatSuppressed = true
        mergedReasons.push('min_repeat_action_interval')
      }
      effective = { action: effective.action, reasons: mergedReasons }
    }

    const actionForState = repeatSuppressed ? 'NO_ACTION' : effective.action

    const toState = stateFor(actionForState, candidate.action, input, previous, this.config)
    const changed = effective.action !== previous.action || toState !== previous.state

    const decision: DecisionEvaluation = {
      action: candidate.action,
      effectiveAction: repeatSuppressed ? previous.action : effective.action,
      fromState: previous.state,
      toState,
      pressure,
      hysteresisHeld,
      cooldownActive,
      cooldownKind,
      cooldownRemainingMs: Math.round(cooldownRemainingMs),
      drivers: input.pressure.drivers,
      reasons: dedupe([
        ...effective.reasons,
        ...(dwellHeld ? ['dwell_suppressed_transition'] : []),
        `coverage_${Math.round(input.pressure.coverage * 100)}pct`,
      ]),
      timestamp: input.timestamp,
    }

    const state: PolicyState = {
      action: decision.effectiveAction,
      state: toState,
      sinceMs: changed ? input.nowMs : previous.sinceMs,
      lastPressure: pressure,
      consecutiveCandidate,
      candidate: candidate.action,
    }

    return { decision, state }
  }

  /** Translate a threshold hit into the action plus its justification. */
  private buildCandidate(action: DecisionAction, input: PolicyInput, threshold: number): Candidate {
    const pressure = input.pressure.restartPressure ?? 0
    switch (action) {
      case 'THROTTLE':
        return {
          action,
          reasons: [`pressure_${pressure}_gte_throttle_${threshold}`, ...topDriverCodes(input.pressure)],
        }
      case 'PAUSE_NEW_WORK':
        return {
          action,
          reasons: [`pressure_${pressure}_gte_pause_${threshold}`, ...topDriverCodes(input.pressure)],
        }
      case 'REQUEST_APP_RESTART':
        return {
          action,
          reasons: [
            `pressure_${pressure}_gte_app_restart_${threshold}`,
            ...topDriverCodes(input.pressure),
            `maintenance_${input.maintenance.phase}`,
          ],
        }
      case 'REQUEST_SYSTEM_REBOOT':
        return {
          action,
          reasons: [
            `pressure_${pressure}_gte_system_reboot_${threshold}`,
            ...topDriverCodes(input.pressure),
            'escalation_from_repeated_app_restart_failure',
          ],
        }
      default:
        return { action: 'NO_ACTION', reasons: ['pressure_below_all_thresholds'] }
    }
  }

  /** Decide whether a restart request may actually be raised right now. */
  private gateRestart(
    action: DecisionAction,
    input: PolicyInput,
  ): { blocked: boolean; reasons: string[]; downgradeTo: DecisionAction } {
    const reasons: string[] = []
    let blocked = false

    if (input.restartCapability !== 'available') {
      blocked = true
      reasons.push('restart_capability_unavailable')
    }

    if (action === 'REQUEST_SYSTEM_REBOOT' && input.restartCapability !== 'available') {
      blocked = true
      reasons.push('system_reboot_requires_restart_adapter')
    }

    if (input.maintenance.urgentOverride) {
      reasons.push('urgent_override_active')
    } else if (!input.maintenance.windowOpen) {
      blocked = true
      reasons.push('maintenance_window_closed', `maintenance_${input.maintenance.phase}`)
    } else if (input.maintenance.phase === 'before_target') {
      blocked = true
      reasons.push('maintenance_before_target_time')
    }

    if (!blocked && input.readiness !== null) {
      if (input.readiness.safe === true) {
        reasons.push('safe_point_confirmed', `safe_point_${input.readiness.estimated_state}`)
      } else if (input.readiness.safe === false) {
        blocked = true
        reasons.push('safe_point_unsafe', `safe_point_reason_${input.readiness.reason}`)
      } else {
        blocked = true
        reasons.push('safe_point_unknown', `safe_point_reason_${input.readiness.reason}`)
      }
    }

    // Ignoring the safe point is allowed for the top escalation only, and never
    // silently: the reason list always says the safe point was not confirmed.
    const escalateAnyway = action === 'REQUEST_SYSTEM_REBOOT' && input.maintenance.urgentOverride
    if (blocked && escalateAnyway && input.restartCapability === 'available') {
      return { blocked: false, reasons: [...reasons, 'escalation_overrides_safe_point'], downgradeTo: action }
    }

    return { blocked, reasons, downgradeTo: blocked ? 'PAUSE_NEW_WORK' : action }
  }
}

/** Cooldown duration for an action. Exported so the scheduler can start it. */
export function cooldownMsOf(config: HealthSchedulerConfig, action: DecisionAction): number {
  switch (cooldownKindOf(action)) {
    case 'throttle':
      return config.cooldowns.throttleMs
    case 'maintenance':
      return config.cooldowns.maintenanceMs
    default:
      return config.cooldowns.escalationMs
  }
}

/**
 * Derive the machine state from the action in force and the context.
 *
 * @param actionForState - the action that will actually be carried out.
 * @param requested - the action the pressure asked for, before any gate. A
 *   restart that was requested but gated is *pending*, and the state names that
 *   rather than the mitigation that temporarily stands in for it.
 */
function stateFor(
  actionForState: DecisionAction,
  requested: DecisionAction,
  input: PolicyInput,
  previous: PolicyState,
  config: HealthSchedulerConfig,
): MachineState {
  const gatedRestart = requested === 'REQUEST_APP_RESTART' && ACTION_LEVEL[actionForState] < ACTION_LEVEL.REQUEST_APP_RESTART
  const gatedReboot = requested === 'REQUEST_SYSTEM_REBOOT' && ACTION_LEVEL[actionForState] < ACTION_LEVEL.REQUEST_APP_RESTART

  switch (actionForState) {
    case 'NO_ACTION': {
      // A restart that is gated by maintenance or the safe point is *pending*,
      // not forgotten: the state says so until the gate opens.
      if (gatedRestart) return 'MAINTENANCE_PENDING'
      if (gatedReboot) return 'ESCALATION_PENDING'
      if (previous.state === 'REQUEST_SYSTEM_REBOOT') return 'SAFE_MODE'
      const pressure = input.pressure.restartPressure
      if (pressure === null) return previous.state === 'HEALTHY' ? 'DEGRADED' : previous.state
      if (pressure <= config.thresholds.throttle.exit) return 'HEALTHY'
      return 'DEGRADED'
    }
    case 'THROTTLE':
      if (gatedReboot) return 'ESCALATION_PENDING'
      if (gatedRestart) return 'MAINTENANCE_PENDING'
      return 'THROTTLED'
    case 'PAUSE_NEW_WORK':
      // Pausing while a restart waits for its window is still "waiting for
      // maintenance"; the pause is the means, not the end.
      if (gatedReboot) return 'ESCALATION_PENDING'
      if (gatedRestart) return 'MAINTENANCE_PENDING'
      return 'PAUSED'
    case 'REQUEST_APP_RESTART':
      return 'REQUEST_APP_RESTART'
    case 'REQUEST_SYSTEM_REBOOT':
      return 'REQUEST_SYSTEM_REBOOT'
    default:
      return previous.state
  }
}

/** Top three driver codes, used to make the reason list explain itself. */
function topDriverCodes(pressure: PressureSnapshot): readonly string[] {
  return pressure.drivers.slice(0, 3).map((driver) => driver.code)
}

/** Stable de-duplication that preserves first-seen order. */
function dedupe(values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (value === '' || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
