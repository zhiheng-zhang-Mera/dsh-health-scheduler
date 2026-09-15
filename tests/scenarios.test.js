/**
 * The six synthetic scenarios from the design document, driven end to end through
 * the real scheduler: providers -> normalization -> rolling windows -> trend ->
 * pressure -> policy.
 *
 * Each test states the acceptance criterion it encodes, so a failure names the
 * promise that broke rather than the number that moved.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { HOUR, HEALTHY_BASELINE, MINUTE, ScenarioRig, SECOND } from './helpers/rig.js'
import { ACTIONS, REASONS, drive } from './helpers/drive.js'

const TICK = 15 * SECOND

describe('synthetic scenarios', () => {
  it('a transient GPU spike never reaches pressure at all', async () => {
    const rig = new ScenarioRig()
    const hardware = rig.provider('hardware', 'hardware', ['cpu_temp_c', 'gpu_temp_c', 'cpu_usage', 'gpu_usage', 'thermal_throttle', 'power_limit_hit'])
    hardware.set(HEALTHY_BASELINE)
    await rig.advance(2 * MINUTE, 8)

    // 90 °C for 30 seconds, sampled every 2 s inside that window.
    hardware.set({ gpu_temp_c: 90 })
    await rig.advance(30 * SECOND, 15)
    const spike = rig.last

    assert.equal(spike.pressure, 0, 'a 30 s spike must not raise restart pressure above zero')
    assert.equal(spike.state, 'HEALTHY')
    assert.equal(rig.actions.every((action) => action === 'NO_ACTION'), true)
  })

  it('a sustained heat soak raises thermal pressure and throttles', async () => {
    const rig = new ScenarioRig()
    const hardware = rig.provider('hardware', 'hardware', ['cpu_temp_c', 'gpu_temp_c', 'cpu_usage', 'gpu_usage', 'thermal_throttle', 'power_limit_hit'])
    hardware.set(HEALTHY_BASELINE)
    await rig.advance(5 * MINUTE, 20)

    hardware.set({ gpu_temp_c: 88, cpu_temp_c: 84, gpu_usage: 0.95, cpu_usage: 0.9, thermal_throttle: 0.05 })
    await rig.advance(20 * MINUTE, 40)
    const thermal = rig.last.dimensions.find((dimension) => dimension.dimension === 'thermal')

    assert.ok(thermal.score !== null && thermal.score > 55, `thermal dimension scored ${thermal.score}`)
    assert.ok(rig.last.pressure > 0, 'sustained heat must move restart pressure')
    assert.ok(
      rig.actions.includes(ACTIONS.pause) || rig.actions.includes(ACTIONS.throttle),
      `expected throttle or pause, saw ${rig.actions.join(', ')}`,
    )
    assert.equal(
      rig.restart.applicationRequests.length,
      0,
      'a heat soak alone must not request a restart, because the maintenance window is closed',
    )
  })

  it('thermal throttle plus long duration is extreme, and says so', async () => {
    const rig = new ScenarioRig()
    const hardware = rig.provider('hardware', 'hardware', ['cpu_temp_c', 'gpu_temp_c', 'cpu_usage', 'gpu_usage', 'thermal_throttle', 'power_limit_hit'])
    hardware.set({ ...HEALTHY_BASELINE, cpu_temp_c: 93, gpu_temp_c: 92, thermal_throttle: 0.6, power_limit_hit: 0.7 })
    await rig.advance(25 * MINUTE, 100)

    const thermal = rig.last.dimensions.find((dimension) => dimension.dimension === 'thermal')
    assert.equal(thermal.level, 'critical')
    assert.ok(
      thermal.metrics.some((metric) => metric.metric === 'thermal_throttle' && metric.level === 'critical'),
      'thermal throttling must itself read as critical',
    )
    assert.ok(rig.last.drivers.some((driver) => driver.code.includes('thermal_throttle') || driver.code.includes('cpu_temp')))
  })

  it('a four-hour RSS leak becomes pressure without any OOM', async () => {
    const rig = new ScenarioRig()
    const memory = rig.provider('memory', 'memory', ['ram_used_ratio', 'ram_available_bytes', 'process_rss_bytes', 'ram_total_bytes'])
    memory.set({ ...HEALTHY_BASELINE, ram_available_bytes: 20 * 1024 ** 3, ram_total_bytes: 32 * 1024 ** 3 })

    const baseRss = 2_000_000_000
    const perHour = 1_200_000_000 // 1.2 GB/h: clearly a leak, nowhere near OOM.
    let t = 0
    for (let step = 0; step < 240; step += 1) {
      t += MINUTE
      memory.set({
        process_rss_bytes: baseRss + (t / HOUR) * perHour,
        ram_used_ratio: 0.62,
      })
      await rig.advance(MINUTE, 1)
    }

    const memoryDimension = rig.last.dimensions.find((dimension) => dimension.dimension === 'memory')
    assert.ok(memoryDimension.score !== null && memoryDimension.score > 40, `memory dimension scored ${memoryDimension.score}`)
    assert.ok(
      rig.last.trends.some((trend) => trend.metric === 'process_rss_bytes' && trend.isWorsening),
      'the leak must appear as a worsening trend',
    )
    assert.ok(
      rig.last.drivers.some((driver) => driver.dimension === 'memory'),
      `expected a memory driver, saw ${rig.last.drivers.map((driver) => driver.code).join(', ')}`,
    )
    assert.ok(rig.last.pressure > 35, `restart pressure was ${rig.last.pressure}`)
  })

  it('worker retry storms reach pressure through the worker dimension', async () => {
    const rig = new ScenarioRig()
    const workers = rig.provider('workers', 'workers', ['timeout_rate', 'failure_rate', 'retry_rate', 'task_latency_ms', 'abnormal_exit_rate', 'spawn_failure_rate', 'queued_tasks', 'queue_delay_ms'])
    workers.set({ ...HEALTHY_BASELINE, queued_tasks: 4 })
    await rig.advance(2 * MINUTE, 8)

    workers.set({ timeout_rate: 0.35, failure_rate: 0.28, retry_rate: 0.7, task_latency_ms: 220_000, abnormal_exit_rate: 0.25 })
    await rig.advance(6 * MINUTE, 24)

    const worker = rig.last.dimensions.find((dimension) => dimension.dimension === 'worker')
    assert.equal(worker.level, 'critical')
    assert.ok(rig.last.drivers.some((driver) => driver.code.startsWith('worker_')))
  })

  it('Computer Use degradation raises interactive pressure before anything restarts', async () => {
    const rig = new ScenarioRig()
    const computerUse = rig.provider('computer-use', 'computer-use', [
      'screenshot_latency_ms',
      'action_latency_ms',
      'verification_retry_rate',
      'missed_target_rate',
      'recovery_rate',
      'desktop_responsiveness_ms',
    ])
    computerUse.set({ screenshot_latency_ms: 400, action_latency_ms: 100, recovery_rate: 0.95, desktop_responsiveness_ms: 90 })
    await rig.advance(2 * MINUTE, 8)

    // The 0.5s -> 1.2s -> 2.8s -> 5s ramp from the design document.
    const ramp = [
      { screenshot_latency_ms: 1_200, action_latency_ms: 400 },
      { screenshot_latency_ms: 2_800, action_latency_ms: 1_100 },
      { screenshot_latency_ms: 5_000, action_latency_ms: 3_500, verification_retry_rate: 0.4, desktop_responsiveness_ms: 2_400 },
    ]
    for (const step of ramp) {
      computerUse.set(step)
      await rig.advance(4 * MINUTE, 16)
    }

    const interactive = rig.last.dimensions.find((dimension) => dimension.dimension === 'computer_use_ui')
    assert.ok(interactive.score !== null && interactive.score > 50, `interactive dimension scored ${interactive.score}`)
    assert.ok(rig.last.trends.some((trend) => trend.metric === 'screenshot_latency_ms' && trend.isWorsening))
  })

  it('a frozen UI heartbeat reaches pressure and is reported as a driver', async () => {
    const rig = new ScenarioRig()
    const ui = rig.provider('ui', 'ui', ['render_latency_ms', 'main_window_heartbeat_ms', 'blank_frame_rate', 'frontend_error_rate'])
    ui.set({ ...HEALTHY_BASELINE })
    await rig.advance(2 * MINUTE, 8)

    ui.set({ render_latency_ms: 2_600, main_window_heartbeat_ms: 12_000, blank_frame_rate: 0.25, frontend_error_rate: 0.3 })
    await rig.advance(8 * MINUTE, 32)

    const interactive = rig.last.dimensions.find((dimension) => dimension.dimension === 'computer_use_ui')
    assert.equal(interactive.level, 'critical')
    assert.ok(rig.last.drivers.some((driver) => driver.code.includes('render_latency') || driver.code.includes('blank_frame')))
  })
})

describe('synthetic scenario invariants', () => {
  it('never emits an action above the pressure that justifies it', async () => {
    const rig = new ScenarioRig()
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle'])
    const thresholds = rig.config.thresholds

    for (const temperature of [40, 70, 82, 86, 91, 95]) {
      hardware.set({ gpu_temp_c: temperature, thermal_throttle: temperature > 90 ? 0.3 : 0 })
      await rig.advance(10 * MINUTE, 40)
    }

    assert.ok(rig.decisions.length > 0, 'the scenario should have produced decisions')
    for (const record of rig.decisions) {
      if (record.action === 'NO_ACTION' || record.pressure === null) continue
      // An action is legitimate while pressure is at or above the level's *enter*
      // threshold, or while it is still inside the level's hysteresis band
      // (between exit and enter) — that band is the whole point of hysteresis.
      const bands = {
        THROTTLE: thresholds.throttle,
        PAUSE_NEW_WORK: thresholds.pause_new_work,
        REQUEST_APP_RESTART: thresholds.request_app_restart,
        REQUEST_SYSTEM_REBOOT: thresholds.request_system_reboot,
      }
      const band = bands[record.action]
      assert.ok(
        record.pressure >= band.exit,
        `action ${record.action} at pressure ${record.pressure} is below its exit band ${band.exit}`,
      )
      assert.ok(
        record.pressure >= band.enter || record.reasons.some((reason) => reason.includes('hysteresis')),
        `action ${record.action} at pressure ${record.pressure} is not in its hysteresis band`,
      )
    }
  })

  it('produces one explainable reason per applied action', async () => {
    const rig = new ScenarioRig()
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c'])
    hardware.set({ gpu_temp_c: 95 })
    await rig.advance(15 * MINUTE, 60)

    assert.ok(rig.decisions.length > 0)
    for (const record of rig.decisions) {
      assert.ok(record.reasons.length > 0, `record #${record.id} has no reasons`)
      assert.ok(
        record.reasons.every((reason) => typeof reason === 'string' && reason.length > 0),
        `record #${record.id} has an empty reason`,
      )
      assert.ok(
        record.reasons.some((reason) => REASONS.prefixes.some((prefix) => reason.startsWith(prefix))),
        `record #${record.id} has no machine-readable reason: ${record.reasons.join(', ')}`,
      )
      // A decision inside the hysteresis band is legitimately justified by the
      // band itself; every other decision must name the pressure that produced it.
      if (!record.reasons.some((reason) => reason.startsWith('hysteresis_'))) {
        assert.ok(
          record.reasons.some((reason) => reason.startsWith('pressure_')),
          `record #${record.id} does not say which pressure produced it`,
        )
      }
      assert.ok(record.outcome.detail.length > 0)
      assert.ok(Number.isFinite(record.coverage))
    }
  })
})

describe('scenario rig self-checks', () => {
  it('drives the same number of ticks it was asked for', async () => {
    const rig = new ScenarioRig()
    rig.provider('hardware', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 50 })
    await rig.advance(10 * MINUTE, 40)
    assert.equal(rig.history.length, 40)
    assert.equal(rig.scheduler.lastTickMs, rig.now)
  })

  it('records provider failures without stopping the loop', async () => {
    const rig = new ScenarioRig()
    const flaky = rig.provider('hardware', 'hardware', ['cpu_temp_c'])
    flaky.set({ cpu_temp_c: 60 })
    flaky.failNext(1)
    await rig.advance(MINUTE, 4)
    const status = rig.scheduler.providerStatus().find((entry) => entry.id === 'hardware')
    assert.equal(status.totalFailures, 1)
    assert.equal(status.totalSuccesses, 3)
    assert.equal(rig.history.length, 4)
  })

  it('keeps ticking through a restart adapter that throws, without a request storm', async () => {
    const rig = new ScenarioRig({
      config: { maintenance: { enabled: true, safePointRequired: false } },
    })
    rig.restart.throwOnRequest = true
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle'])
    // 100 °C is past the urgent-override pressure, so the request is not gated
    // by the window and the adapter is genuinely called.
    hardware.set({ gpu_temp_c: 100, thermal_throttle: 0.8 })
    await drive(rig, {
      minutes: 30,
      tickMs: TICK,
      maintenanceWindow: true,
      onTick: () => hardware.set({ gpu_temp_c: 100, thermal_throttle: 0.8 }),
    })

    assert.ok(rig.history.length > 0, 'the loop must survive a throwing adapter')
    const last = rig.last
    assert.equal(last.capabilities.restart, 'available')
    const allWarnings = rig.history.flatMap((snapshot) => snapshot.warnings)
    assert.ok(
      allWarnings.some((warning) => warning.includes('not applied')),
      `expected a "not applied" warning, saw: ${allWarnings.slice(0, 5).join(' | ')}`,
    )
    // 30 minutes at a 15 s tick is 120 evaluations of a permanently critical
    // machine. The cooldown must collapse those into a handful of attempts
    // instead of one request per tick.
    const attempts = rig.restart.applicationRequests.length + rig.restart.requests.filter((r) => r.mode === 'system').length
    assert.ok(attempts >= 1, 'the adapter should have been called at least once')
    assert.ok(attempts <= 3, `expected cooldown to bound attempts, saw ${attempts}`)
  })
})
