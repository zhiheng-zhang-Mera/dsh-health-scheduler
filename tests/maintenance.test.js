/**
 * Maintenance windows and the deferral ledger.
 *
 * The design is explicit that this is not a cron job: a target time inside a
 * window, a maximum deferral, an urgent override, and a safe point. These tests
 * pin the state machine, including the DST-safe wall-clock arithmetic.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  clockWithin,
  computeMaintenancePicture,
  formatClock,
  formatDuration,
  maintenanceAllowsRequest,
  nextOccurrence,
  parseClock,
  previousOccurrence,
} from '../lib/core/maintenance.js'
import { foldReadiness, SafePointRegistry } from '../lib/core/safe-point.js'
import { resolveConfig } from '../lib/core/config.js'

/** A local-time instant on a fixed day, built from local calendar fields. */
function local(year, month, day, hour, minute, second = 0) {
  return new Date(year, month - 1, day, hour, minute, second, 0).getTime()
}

function configWith(maintenance) {
  return resolveConfig({ maintenance }).maintenance
}

describe('wall-clock parsing', () => {
  it('parses valid times and rejects everything else', () => {
    assert.equal(parseClock('00:00'), 0)
    assert.equal(parseClock('04:00'), 4 * 3_600_000)
    assert.equal(parseClock('23:59'), 23 * 3_600_000 + 59 * 60_000)
    assert.throws(() => parseClock('24:00'))
    assert.throws(() => parseClock('4:00'))
    assert.throws(() => parseClock('04:60'))
    assert.throws(() => parseClock('nope'))
  })

  it('finds the previous and next occurrence of a wall clock time', () => {
    const at = local(2026, 3, 1, 12, 0)
    assert.equal(previousOccurrence('04:00', at), local(2026, 3, 1, 4, 0))
    assert.equal(nextOccurrence('04:00', at), local(2026, 3, 2, 4, 0))
    // Exactly on the boundary, "previous" is now and "next" stays now.
    const onTarget = local(2026, 3, 1, 4, 0)
    assert.equal(previousOccurrence('04:00', onTarget), onTarget)
    assert.equal(nextOccurrence('04:00', onTarget), onTarget)
  })

  it('tolerates a window that wraps past midnight', () => {
    assert.equal(clockWithin('23:30', '23:00', '02:00'), true)
    assert.equal(clockWithin('01:30', '23:00', '02:00'), true)
    assert.equal(clockWithin('12:00', '23:00', '02:00'), false)
    assert.equal(clockWithin('04:00', '03:30', '05:00'), true)
    assert.equal(clockWithin('03:00', '03:30', '05:00'), false)
  })

  it('formats durations for humans and evidence strings', () => {
    assert.equal(formatDuration(90_000), '1m 30s')
    assert.equal(formatDuration(3 * 3_600_000 + 5 * 60_000), '3h 5m')
    assert.equal(formatDuration(0), '0s')
    assert.equal(formatClock(local(2026, 3, 1, 4, 5)), '04:05')
  })
})

describe('maintenance picture', () => {
  it('reports disabled when scheduled maintenance is off', () => {
    const picture = computeMaintenancePicture(configWith({ enabled: false }), local(2026, 3, 1, 4, 0), null, 50)
    assert.equal(picture.phase, 'outside_window')
    assert.equal(picture.windowOpen, false)
    assert.equal(picture.nextTargetAt, null)
    assert.match(picture.summary, /disabled/)
  })

  it('is outside the window before it opens', () => {
    const config = configWith({ enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' })
    const picture = computeMaintenancePicture(config, local(2026, 3, 1, 2, 0), null, 10)
    assert.equal(picture.phase, 'outside_window')
    assert.equal(picture.windowOpen, false)
  })

  it('is before_target inside the window but ahead of the target', () => {
    const config = configWith({ enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' })
    const picture = computeMaintenancePicture(config, local(2026, 3, 1, 3, 45), null, 10)
    assert.equal(picture.windowOpen, true)
    assert.equal(picture.phase, 'before_target')
    assert.equal(picture.windowClosesInMs, 75 * 60_000)
    assert.equal(maintenanceAllowsRequest(picture, config), false, 'the target has not been reached yet')
  })

  it('is at_target exactly on the target instant', () => {
    const config = configWith({ enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' })
    const picture = computeMaintenancePicture(config, local(2026, 3, 1, 4, 0), null, 10)
    assert.equal(picture.phase, 'at_target')
    assert.equal(maintenanceAllowsRequest(picture, config), true)
  })

  it('is deferred while the deferral budget lasts, then overdue', () => {
    const config = configWith({
      enabled: true,
      targetTime: '04:00',
      windowStart: '03:30',
      windowEnd: '05:00',
      maxDeferMs: 30 * 60_000,
    })
    const deferredSince = local(2026, 3, 1, 4, 0)

    const early = computeMaintenancePicture(config, local(2026, 3, 1, 4, 10), deferredSince, 10)
    assert.equal(early.phase, 'deferred')
    assert.equal(early.deferExhausted, false)
    assert.equal(early.deferredMs, 10 * 60_000)
    assert.equal(maintenanceAllowsRequest(early, config), true)

    const late = computeMaintenancePicture(config, local(2026, 3, 1, 4, 40), deferredSince, 10)
    assert.equal(late.phase, 'overdue')
    assert.equal(late.deferExhausted, true)
    assert.match(late.summary, /max defer exhausted/)
    assert.equal(maintenanceAllowsRequest(late, config), true, 'an exhausted deferral means "go now", not "give up"')
  })

  it('takes the urgent override outside the window', () => {
    const config = configWith({
      enabled: true,
      targetTime: '04:00',
      windowStart: '03:30',
      windowEnd: '05:00',
      urgentOverridePressure: 92,
    })
    const picture = computeMaintenancePicture(config, local(2026, 3, 1, 14, 0), null, 93)
    assert.equal(picture.phase, 'urgent_override')
    assert.equal(picture.urgentOverride, true)
    assert.equal(picture.windowOpen, false)
    assert.equal(maintenanceAllowsRequest(picture, config), true)

    const below = computeMaintenancePicture(config, local(2026, 3, 1, 14, 0), null, 91)
    assert.equal(below.phase, 'outside_window')
    assert.equal(maintenanceAllowsRequest(below, config), false)
  })

  it('never allows a request when the configuration forbids one', () => {
    const config = configWith({ enabled: true, allowAppRestart: false, targetTime: '04:00' })
    const picture = computeMaintenancePicture(config, local(2026, 3, 1, 4, 30), null, 99)
    assert.equal(maintenanceAllowsRequest(picture, config), false)
  })

  it('resolves the window across a spring-forward style day boundary', () => {
    // The window is expressed in local calendar fields, so the picture must be
    // computed from local hours rather than by adding fixed millisecond offsets.
    const config = configWith({ enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' })
    for (const day of [1, 2, 3, 28]) {
      const picture = computeMaintenancePicture(config, local(2026, 3, day, 4, 0), null, 0)
      assert.equal(picture.phase, 'at_target', `day ${day} should be at target`)
      assert.equal(new Date(picture.nextTargetAt).getHours(), 4)
      assert.equal(new Date(picture.nextTargetAt).getMinutes(), 0)
    }
  })
})

describe('safe points', () => {
  it('reports unknown, not safe, when nothing is registered', async () => {
    const registry = new SafePointRegistry()
    assert.equal(registry.isEmpty, true)
    const readiness = await registry.readiness()
    assert.equal(readiness.safe, null)
    assert.equal(readiness.reason, 'no_safe_point_source')
    assert.equal(readiness.estimated_state, 'unknown')
  })

  it('folds sources worst-first', () => {
    const safe = foldReadiness([{ source: 'core', safe: true, reason: 'idle', estimatedState: 'idle' }])
    assert.equal(safe.safe, true)
    assert.equal(safe.estimated_state, 'idle')

    const unsafe = foldReadiness([
      { source: 'core', safe: true, reason: 'idle', estimatedState: 'idle' },
      { source: 'git', safe: false, reason: 'git_commit_in_progress', estimatedState: 'busy' },
    ])
    assert.equal(unsafe.safe, false)
    assert.equal(unsafe.reason, 'git_commit_in_progress')
    assert.equal(unsafe.estimated_state, 'busy')

    const mixed = foldReadiness([
      { source: 'core', safe: true, reason: 'idle', estimatedState: 'idle' },
      { source: 'mystery', safe: null, reason: 'no_answer', estimatedState: 'unknown' },
    ])
    assert.equal(mixed.safe, null, 'a silent source must not be read as "safe"')
  })

  it('contains a throwing source and a hanging source', async () => {
    const registry = new SafePointRegistry()
    registry.register({
      id: 'thrower',
      readiness() {
        throw new Error('core is down')
      },
    })
    registry.register({
      id: 'hanger',
      readiness() {
        return new Promise(() => {})
      },
    })
    const readiness = await registry.readiness(50)
    assert.equal(readiness.safe, null)
    assert.equal(readiness.sources.length, 2)
    assert.equal(readiness.sources.find((entry) => entry.source === 'thrower').reason, 'safe_point_source_failed')
    assert.equal(readiness.sources.find((entry) => entry.source === 'hanger').reason, 'safe_point_timeout')
  })

  it('unregisters through the disposer', async () => {
    const registry = new SafePointRegistry()
    const dispose = registry.register({ id: 'a', readiness: () => ({ source: 'a', safe: true, reason: 'idle', estimatedState: 'idle' }) })
    assert.deepEqual(registry.sources(), ['a'])
    dispose()
    assert.deepEqual(registry.sources(), [])
    assert.equal((await registry.readiness()).safe, null)
  })
})
