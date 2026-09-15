/**
 * Policy: hysteresis, debounce, dwell, cooldowns, the restart gate, and the state
 * machine. These are the rules that keep a monitoring plugin from becoming a
 * source of churn, so each one is tested in isolation with hand-built inputs.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveConfig } from '../lib/core/config.js'
import {
  PolicyEngine,
  cooldownKindOf,
  cooldownMsOf,
  initialActionAttempts,
  initialPolicyState,
} from '../lib/core/policy.js'
import { ACTIONS, STATES } from './helpers/drive.js'

const T0 = Date.parse('2026-03-01T00:00:00.000Z')

/** A minimal pressure snapshot with a chosen total. */
function pressure(total, drivers = []) {
  return {
    timestamp: new Date(T0).toISOString(),
    restartPressure: total,
    coverage: 1,
    unknownDimensions: [],
    dimensions: [],
    drivers,
    primaryCause: drivers[0]?.detail ?? null,
  }
}

function maintenance(overrides = {}) {
  return {
    phase: 'outside_window',
    windowOpen: false,
    nextTargetAt: null,
    windowClosesInMs: 0,
    deferredMs: 0,
    deferExhausted: false,
    urgentOverride: false,
    summary: 'test',
    ...overrides,
  }
}

const OPEN_WINDOW = { phase: 'at_target', windowOpen: true, summary: 'target reached' }

function input(overrides = {}) {
  return {
    pressure: pressure(overrides.total ?? 0, overrides.drivers ?? []),
    maintenance: overrides.maintenance ?? maintenance(),
    readiness: overrides.readiness === undefined ? null : overrides.readiness,
    restartCapability: overrides.restartCapability ?? 'available',
    workerControlCapability: overrides.workerControlCapability ?? 'available',
    nowMs: overrides.nowMs ?? T0,
    timestamp: new Date(overrides.nowMs ?? T0).toISOString(),
    attempts: overrides.attempts ?? initialActionAttempts(),
    ...overrides.extra,
  }
}

function engine(overrides = {}) {
  return new PolicyEngine(resolveConfig(overrides))
}

/** Run one evaluation from a fresh state. */
function decide(policyEngine, inputValue, state = initialPolicyState(inputValue.nowMs)) {
  return policyEngine.evaluate(inputValue, state)
}

describe('action ladder', () => {
  // Debounce is a separate concern with its own tests below; the ladder tests
  // exercise threshold mapping, so they run without it.
  const policy = engine({ antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 } })

  it('does nothing below the throttle threshold', () => {
    const { decision } = decide(policy, input({ total: 40 }))
    assert.equal(decision.effectiveAction, ACTIONS.none)
    assert.equal(decision.toState, STATES.healthy)
  })

  it('throttles at the throttle enter threshold', () => {
    const { decision } = decide(policy, input({ total: 55 }))
    assert.equal(decision.effectiveAction, ACTIONS.throttle)
    assert.equal(decision.toState, STATES.throttled)
    assert.ok(decision.reasons.includes('pressure_55_gte_throttle_55'))
  })

  it('pauses new work at the pause threshold', () => {
    const { decision } = decide(policy, input({ total: 72 }))
    assert.equal(decision.effectiveAction, ACTIONS.pause)
    assert.equal(decision.toState, STATES.paused)
  })

  it('holds a restart request until the maintenance window opens', () => {
    const { decision } = decide(policy, input({ total: 85, maintenance: maintenance() }))
    assert.equal(decision.action, ACTIONS.appRestart, 'the raw action is still the restart')
    assert.equal(decision.effectiveAction, ACTIONS.pause, 'but the effective action is the fallback')
    assert.equal(decision.toState, STATES.maintenancePending)
    assert.ok(decision.reasons.includes('maintenance_window_closed'))
  })

  it('requests an application restart inside an open window with a confirmed safe point', () => {
    const { decision } = decide(
      policy,
      input({
        total: 85,
        maintenance: maintenance(OPEN_WINDOW),
        readiness: { safe: true, reason: 'safe_point_reached', estimated_state: 'idle', sources: [], summary: 'idle' },
      }),
    )
    assert.equal(decision.effectiveAction, ACTIONS.appRestart)
    assert.equal(decision.toState, STATES.appRestart)
    assert.ok(decision.reasons.includes('safe_point_confirmed'))
  })

  it('escalates to a system reboot only above the top threshold', () => {
    const { decision } = decide(
      policy,
      input({
        total: 96,
        maintenance: maintenance(OPEN_WINDOW),
        readiness: { safe: true, reason: 'safe_point_reached', estimated_state: 'idle', sources: [], summary: 'idle' },
      }),
      { ...initialPolicyState(T0), candidate: 'REQUEST_SYSTEM_REBOOT', consecutiveCandidate: 5, action: 'REQUEST_SYSTEM_REBOOT', state: STATES.appRestart },
    )
    assert.equal(decision.effectiveAction, ACTIONS.systemReboot)
    assert.equal(decision.toState, STATES.systemReboot)
  })
})

describe('anti-flapping', () => {
  it('holds the active action while pressure sits inside the hysteresis band', () => {
    const policy = engine()
    const first = decide(policy, input({ total: 60 }))
    assert.equal(first.decision.effectiveAction, ACTIONS.throttle)

    // 50 is below the enter threshold (55) but above the exit threshold (45).
    const held = decide(policy, input({ total: 50, nowMs: T0 + 60_000 }), first.state)
    assert.equal(held.decision.effectiveAction, ACTIONS.throttle)
    assert.equal(held.decision.hysteresisHeld, true)

    // 40 is below the exit threshold, so the action is released.
    const released = decide(policy, input({ total: 40, nowMs: T0 + 120_000 }), held.state)
    assert.equal(released.decision.effectiveAction, ACTIONS.none)
    assert.equal(released.decision.toState, STATES.healthy)
  })

  it('does not oscillate around a threshold', () => {
    const policy = engine({ antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 } })
    let state = initialPolicyState(T0)
    const actions = []
    const series = [56, 54, 56, 54, 56, 54, 56, 54]
    series.forEach((total, index) => {
      const result = decide(policy, input({ total, nowMs: T0 + index * 15_000 }), state)
      state = result.state
      actions.push(result.decision.effectiveAction)
    })
    // The first crossing throttles; everything after stays throttled because the
    // exit band is 45 and the series never falls that far.
    assert.deepEqual(actions, Array(series.length).fill(ACTIONS.throttle))
  })

  it('debounces a high-risk action across evaluations', () => {
    const policy = engine({ antiFlap: { debounceEvaluations: 3, minStateDwellMs: 0, minRepeatActionMs: 0 } })
    let state = initialPolicyState(T0)
    const high = () =>
      input({
        total: 96,
        maintenance: maintenance(OPEN_WINDOW),
        readiness: { safe: true, reason: 'safe_point_reached', estimated_state: 'idle', sources: [], summary: 'idle' },
      })

    const first = decide(policy, high(), state)
    state = first.state
    assert.equal(first.decision.effectiveAction, ACTIONS.none, 'evaluation 1 of 3 must not act')
    assert.ok(first.decision.reasons.some((reason) => reason.startsWith('debounce_')))

    const second = decide(policy, high(), state)
    state = second.state
    assert.equal(second.decision.effectiveAction, ACTIONS.none, 'evaluation 2 of 3 must not act')

    const third = decide(policy, high(), state)
    assert.equal(third.decision.effectiveAction, ACTIONS.systemReboot, 'evaluation 3 of 3 acts')
  })

  it('holds a transition to a calmer level until the dwell time elapses', () => {
    const policy = engine({ antiFlap: { debounceEvaluations: 1, minStateDwellMs: 120_000, minRepeatActionMs: 0 } })
    const first = decide(policy, input({ total: 60 }))
    assert.equal(first.decision.effectiveAction, ACTIONS.throttle)

    const tooSoon = decide(policy, input({ total: 40, nowMs: T0 + 15_000 }), first.state)
    assert.equal(tooSoon.decision.effectiveAction, ACTIONS.throttle, 'dwell holds the throttled state')
    assert.ok(tooSoon.decision.reasons.includes('dwell_suppressed_transition'))

    const later = decide(policy, input({ total: 40, nowMs: T0 + 130_000 }), first.state)
    assert.equal(later.decision.effectiveAction, ACTIONS.none, 'once the dwell elapses the state recovers')
  })

  it('never delays the first crossing out of NO_ACTION', () => {
    const policy = engine({ antiFlap: { debounceEvaluations: 1, minStateDwellMs: 600_000, minRepeatActionMs: 0 } })
    const { decision } = decide(policy, input({ total: 60 }))
    assert.equal(decision.effectiveAction, ACTIONS.throttle, 'a fresh throttle must not wait out a dwell timer')
  })

  it('cooldown suppresses a repeat but not a recovery', () => {
    const policy = engine({ antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 600_000 } })
    const config = resolveConfig()
    const attempted = {
      lastAttemptAt: T0,
      lastAttemptAction: ACTIONS.throttle,
      cooldowns: { throttle: T0 + config.cooldowns.throttleMs, maintenance: 0, escalation: 0 },
    }

    // A repeat inside the cooldown is suppressed.
    const repeat = decide(
      policy,
      input({ total: 60, nowMs: T0 + 60_000, attempts: attempted }),
      { ...initialPolicyState(T0), action: ACTIONS.throttle, state: STATES.throttled },
    )
    assert.equal(repeat.decision.cooldownActive, true)
    assert.equal(repeat.decision.cooldownKind, 'throttle')
    assert.equal(repeat.decision.effectiveAction, ACTIONS.throttle, 'the action stays in force')
    assert.ok(repeat.decision.reasons.some((reason) => reason.includes('cooldown')))

    // Recovery is never blocked by a cooldown.
    const recovered = decide(
      policy,
      input({ total: 20, nowMs: T0 + 120_000, attempts: attempted }),
      { ...initialPolicyState(T0), action: ACTIONS.throttle, state: STATES.throttled },
    )
    assert.equal(recovered.decision.effectiveAction, ACTIONS.none)
    assert.equal(recovered.decision.toState, STATES.healthy)
  })

  it('maps actions onto cooldown buckets and durations', () => {
    const config = resolveConfig()
    assert.equal(cooldownKindOf('THROTTLE'), 'throttle')
    assert.equal(cooldownKindOf('PAUSE_NEW_WORK'), 'throttle')
    assert.equal(cooldownKindOf('REQUEST_APP_RESTART'), 'maintenance')
    assert.equal(cooldownKindOf('REQUEST_SYSTEM_REBOOT'), 'escalation')
    assert.equal(cooldownMsOf(config, 'THROTTLE'), config.cooldowns.throttleMs)
    assert.equal(cooldownMsOf(config, 'REQUEST_SYSTEM_REBOOT'), config.cooldowns.escalationMs)
  })
})

describe('restart gate', () => {
  const policy = engine({ antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0 } })

  it('blocks a restart when the restart capability is unavailable', () => {
    const { decision } = decide(
      policy,
      input({ total: 85, maintenance: maintenance(OPEN_WINDOW), restartCapability: 'unavailable' }),
    )
    assert.equal(decision.effectiveAction, ACTIONS.pause)
    assert.ok(decision.reasons.includes('restart_capability_unavailable'))
  })

  it('blocks a restart when the safe point is unsafe', () => {
    const { decision } = decide(
      policy,
      input({
        total: 85,
        maintenance: maintenance(OPEN_WINDOW),
        readiness: { safe: false, reason: 'git_commit_in_progress', estimated_state: 'busy', sources: [], summary: 'busy' },
      }),
    )
    assert.equal(decision.effectiveAction, ACTIONS.pause)
    assert.ok(decision.reasons.includes('safe_point_unsafe'))
    assert.ok(decision.reasons.includes('safe_point_reason_git_commit_in_progress'))
  })

  it('blocks a restart when the safe point is unknown, because unknown is not yes', () => {
    const { decision } = decide(
      policy,
      input({
        total: 85,
        maintenance: maintenance(OPEN_WINDOW),
        readiness: { safe: null, reason: 'no_safe_point_source', estimated_state: 'unknown', sources: [], summary: 'unknown' },
      }),
    )
    assert.equal(decision.effectiveAction, ACTIONS.pause)
    assert.ok(decision.reasons.includes('safe_point_unknown'))
  })

  it('blocks a restart before the target time even inside the window', () => {
    const { decision } = decide(
      policy,
      input({ total: 85, maintenance: maintenance({ phase: 'before_target', windowOpen: true }) }),
    )
    assert.equal(decision.effectiveAction, ACTIONS.pause)
    assert.equal(decision.toState, STATES.maintenancePending)
    assert.ok(decision.reasons.includes('maintenance_before_target_time'))
  })

  it('blocks a restart when the configuration forbids scheduled restarts', () => {
    // `allowAppRestart: false` is a maintenance switch, so the module that owns the
    // maintenance decision is the one that has to honour it.
    const strict = engine({
      antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0 },
      maintenance: { enabled: true, allowAppRestart: false },
    })
    const { decision } = decide(
      strict,
      input({
        total: 85,
        maintenance: maintenance(OPEN_WINDOW),
        readiness: { safe: true, reason: 'safe_point_reached', estimated_state: 'idle', sources: [], summary: 'idle' },
      }),
    )
    assert.equal(decision.action, ACTIONS.appRestart)
    assert.equal(decision.effectiveAction, ACTIONS.pause)
    assert.ok(decision.reasons.includes('maintenance_app_restart_disabled'))
  })

  it('lets an urgent override escalate past the window', () => {
    const { decision } = decide(
      policy,
      input({
        total: 97,
        maintenance: maintenance({ phase: 'urgent_override', windowOpen: false, urgentOverride: true }),
        readiness: { safe: false, reason: 'busy', estimated_state: 'critical', sources: [], summary: 'busy' },
      }),
      {
        ...initialPolicyState(T0),
        action: ACTIONS.appRestart,
        state: STATES.appRestart,
        candidate: 'REQUEST_SYSTEM_REBOOT',
        consecutiveCandidate: 5,
      },
    )
    assert.equal(decision.effectiveAction, ACTIONS.systemReboot)
    assert.ok(decision.reasons.includes('urgent_override_active'))
    assert.ok(decision.reasons.includes('escalation_overrides_safe_point'))
  })

  it('does not delay a critical escalation behind a debounce by accident', () => {
    // Two evaluations of a critical machine are enough under the default
    // debounce of 2; the point is that the first one is held and the second acts.
    const debounced = engine()
    const critical = () =>
      input({
        total: 97,
        maintenance: maintenance(OPEN_WINDOW),
        readiness: { safe: true, reason: 'safe_point_reached', estimated_state: 'idle', sources: [], summary: 'idle' },
      })
    const first = decide(debounced, critical(), initialPolicyState(T0))
    const second = decide(debounced, critical(), first.state)
    assert.equal(first.decision.effectiveAction, ACTIONS.none)
    assert.equal(second.decision.effectiveAction, ACTIONS.systemReboot)
  })
})

describe('machine states', () => {
  it('walks HEALTHY -> DEGRADED -> THROTTLED -> HEALTHY', () => {
    const policy = engine({ antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 } })
    let state = initialPolicyState(T0)

    const degraded = decide(policy, input({ total: 50 }), state)
    state = degraded.state
    assert.equal(degraded.decision.toState, STATES.degraded, 'pressure above the exit band but below enter is DEGRADED')

    const throttled = decide(policy, input({ total: 60, nowMs: T0 + 60_000 }), state)
    state = throttled.state
    assert.equal(throttled.decision.toState, STATES.throttled)

    const healthy = decide(policy, input({ total: 10, nowMs: T0 + 120_000 }), state)
    assert.equal(healthy.decision.toState, STATES.healthy)
  })

  it('marks the state DEGRADED when no telemetry is available at all', () => {
    const policy = engine()
    const { decision } = decide(policy, input({ total: null, extra: { pressure: pressure(null) } }))
    assert.equal(decision.pressure, null)
    assert.equal(decision.toState, STATES.degraded, 'unknown telemetry is not health')
  })

  it('reaches SAFE_MODE only after a system reboot was requested', () => {
    const policy = engine({ antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 } })
    const previous = {
      ...initialPolicyState(T0),
      action: ACTIONS.systemReboot,
      state: STATES.systemReboot,
      candidate: 'REQUEST_SYSTEM_REBOOT',
    }
    const { decision } = decide(policy, input({ total: 40, nowMs: T0 + 600_000 }), previous)
    assert.equal(decision.toState, STATES.safeMode)
  })
})
