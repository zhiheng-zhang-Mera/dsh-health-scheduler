/**
 * Scheduler integration: the tick pipeline, provider failure isolation, adapter
 * degradation, the audit log, and the long-run anti-storm guarantees.
 */

import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { resolveConfig } from '../lib/core/config.js'
import { DecisionLog } from '../lib/audit/decision-log.js'
import { ProviderRegistry } from '../lib/providers/registry.js'
import {
  UnavailableRestartAdapter,
  UnavailableWorkerControlAdapter,
  outcomeForAction,
} from '../lib/adapters/types.js'
import { MINUTE, ScenarioRig, ScriptedSafePoint } from './helpers/rig.js'
import { ACTIONS, STATES, drive } from './helpers/drive.js'

const T0 = Date.parse('2026-03-01T00:00:00.000Z')

describe('ProviderRegistry', () => {
  function registry(overrides = {}) {
    return new ProviderRegistry({
      sampling: { providerBackoffMs: 1_000, providerBackoffMaxMs: 8_000, ...overrides.sampling },
      resilience: { providerFailureLimit: 2, providerRetryAfterBackoff: true, reportDegradedCapability: true },
      disabledProviders: overrides.disabledProviders ?? [],
    })
  }

  it('rejects a duplicate provider id', () => {
    const reg = registry()
    const provider = { id: 'a', group: 'hardware', provides: [], sample: () => ({ provider: 'a', timestamp: '', metrics: {} }) }
    reg.register(provider)
    assert.throws(() => reg.register(provider), /already registered/)
  })

  it('contains a throwing provider and keeps the others', async () => {
    const reg = registry()
    reg.register({
      id: 'good',
      group: 'hardware',
      provides: ['cpu_temp_c'],
      sample: () => ({ provider: 'good', timestamp: new Date(T0).toISOString(), metrics: { cpu_temp_c: 50 } }),
    })
    reg.register({
      id: 'bad',
      group: 'memory',
      provides: ['ram_used_ratio'],
      sample: () => {
        throw new Error('sensor exploded')
      },
    })
    const round = await reg.sampleAll(T0, new Date(T0).toISOString())
    assert.equal(round.samples.length, 1)
    assert.equal(round.samples[0].provider, 'good')
    assert.equal(round.failures.length, 1)
    assert.equal(round.failures[0].provider, 'bad')
    assert.match(round.failures[0].message, /sensor exploded/)
  })

  it('applies an exponential backoff after the failure limit and retries later', async () => {
    const reg = registry()
    reg.register({
      id: 'flaky',
      group: 'hardware',
      provides: [],
      sample: () => {
        throw new Error('nope')
      },
    })
    const t = T0
    await reg.sampleAll(t, new Date(t).toISOString())
    const afterFirst = reg.status(t + 1)[0]
    assert.equal(afterFirst.available, true, 'below the failure limit the provider is still tried')

    await reg.sampleAll(t + 1, new Date(t + 1).toISOString())
    const afterSecond = reg.status(t + 2)[0]
    assert.equal(afterSecond.available, false, 'at the failure limit the provider backs off')
    assert.ok(afterSecond.backoffRemainingMs > 0)

    const skipped = await reg.sampleAll(t + 100, new Date(t + 100).toISOString())
    assert.deepEqual(skipped.skipped, ['flaky'])
    assert.equal(skipped.failures.length, 0, 'a skipped provider produces no new failure record')

    const later = await reg.sampleAll(t + 60_000, new Date(t + 60_000).toISOString())
    assert.equal(later.failures.length, 1, 'after the backoff the provider is retried')
  })

  it('honours the disabled list and per-provider enable flag without failing', async () => {
    const reg = registry({ disabledProviders: ['off'] })
    reg.register({ id: 'off', group: 'hardware', provides: [], sample: () => ({ provider: 'off', timestamp: '', metrics: {} }) })
    reg.register({ id: 'flagged', group: 'hardware', provides: [], enabled: false, sample: () => ({ provider: 'flagged', timestamp: '', metrics: {} }) })
    const round = await reg.sampleAll(T0, new Date(T0).toISOString())
    assert.deepEqual(round.skipped, ['flagged', 'off'])
    assert.equal(round.samples.length, 0)
  })

  it('notifies failure listeners without letting one break sampling', async () => {
    const reg = registry()
    const seen = []
    reg.onFailure(() => {
      throw new Error('listener bug')
    })
    reg.onFailure((failure) => seen.push(failure.provider))
    reg.register({
      id: 'bad',
      group: 'hardware',
      provides: [],
      sample: () => {
        throw new Error('x')
      },
    })
    await reg.sampleAll(T0, new Date(T0).toISOString())
    assert.deepEqual(seen, ['bad'])
  })
})

describe('unavailable adapters', () => {
  it('report unavailable and refuse without throwing', async () => {
    const restart = new UnavailableRestartAdapter()
    assert.equal(restart.capability, 'unavailable')
    const response = await restart.requestApplicationRestart()
    assert.equal(response.accepted, false)
    assert.equal(response.state, 'rejected')
    assert.match(response.reason, /dsh-restart/)

    const worker = new UnavailableWorkerControlAdapter()
    assert.equal(worker.capability, 'unavailable')
    await worker.setConcurrencyLimit(2)
    await worker.pauseNewWorkers()
    await worker.resumeNormalConcurrency()
    assert.equal(worker.currentConcurrencyLimit(), null)
  })

  it('builds audit outcomes from adapter results', () => {
    assert.equal(outcomeForAction({ applied: true, adapter: 'x', detail: 'd' }).capability, 'available')
    assert.equal(outcomeForAction({ applied: false, adapter: 'x', detail: 'd' }).capability, 'failed')
    assert.equal(outcomeForAction({ applied: true, adapter: 'x', detail: 'd', reference: 'r-1' }).reference, 'r-1')
  })
})

describe('HealthScheduler', () => {
  it('produces a snapshot with unknown dimensions when nothing is registered', async () => {
    const rig = new ScenarioRig()
    const snapshot = await rig.tick()
    assert.equal(snapshot.pressure, null)
    assert.equal(snapshot.coverage, 0)
    assert.equal(snapshot.state, STATES.degraded)
    assert.ok(snapshot.unknownDimensions.includes('thermal'))
    assert.deepEqual(snapshot.providers, [])
    assert.ok(
      snapshot.warnings.some((warning) => warning.includes('no provider produced a sample')),
      `expected a diagnostic warning, saw ${JSON.stringify(snapshot.warnings)}`,
    )
  })

  it('records metrics, computes pressure and keeps coverage honest', async () => {
    const rig = new ScenarioRig()
    rig.provider('hardware', 'hardware', ['cpu_temp_c', 'gpu_temp_c'])
    rig.providers[0].set({ cpu_temp_c: 60, gpu_temp_c: 55 })
    await rig.advance(MINUTE, 4)
    const snapshot = rig.last
    assert.ok(snapshot.pressure !== null)
    assert.ok(snapshot.coverage > 0 && snapshot.coverage < 1, 'only the thermal dimension is measured')
    assert.ok(snapshot.unknownDimensions.includes('worker'))
    assert.equal(snapshot.metrics.cpu_temp_c, 60)
    assert.equal(snapshot.metrics.ram_used_ratio, undefined, 'an unmeasured metric is absent, not zero')
  })

  it('applies a throttle through the worker-control adapter and releases it on recovery', async () => {
    // A purely thermal signal at this level yields a pressure in the forties, so
    // the bands are placed around it. The subject under test is the adapter round
    // trip and the release, not the threshold arithmetic.
    const rig = new ScenarioRig({
      config: {
        throttle: { concurrencyLimit: 2 },
        thresholds: {
          throttle: { enter: 10, exit: 5 },
          pause_new_work: { enter: 70, exit: 60 },
          request_app_restart: { enter: 80, exit: 68 },
          request_system_reboot: { enter: 95, exit: 85 },
        },
      },
    })
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle'])
    hardware.set({ gpu_temp_c: 85, thermal_throttle: 0.2 })
    await rig.advance(10 * MINUTE, 40)

    assert.equal(rig.decisions[0]?.action, ACTIONS.throttle, `decisions were ${JSON.stringify(rig.decisions.map((r) => r.action))}`)
    assert.deepEqual(rig.workerControl.calls, [['setConcurrencyLimit', 2]], 'the configured limit is applied once')
    assert.ok(rig.last.pressure !== null && rig.last.pressure < 70, `pressure was ${rig.last.pressure}`)

    hardware.set({ gpu_temp_c: 45, thermal_throttle: 0 })
    await rig.advance(20 * MINUTE, 80)
    assert.ok(
      rig.workerControl.calls.some(([name]) => name === 'resumeNormalConcurrency'),
      'recovery must release the throttle',
    )
  })

  it('refuses to guess a concurrency target when none is configured or derivable', async () => {
    const rig = new ScenarioRig({
      config: {
        thresholds: {
          throttle: { enter: 10, exit: 5 },
          pause_new_work: { enter: 70, exit: 60 },
          request_app_restart: { enter: 80, exit: 68 },
          request_system_reboot: { enter: 95, exit: 85 },
        },
      },
    })
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle'])
    hardware.set({ gpu_temp_c: 85, thermal_throttle: 0.2 })
    await rig.advance(10 * MINUTE, 40)
    const throttles = rig.decisions.filter((record) => record.action === ACTIONS.throttle)
    assert.ok(throttles.length > 0, 'the scenario should have produced a throttle decision')
    assert.equal(throttles[0].outcome.applied, false)
    assert.match(throttles[0].outcome.detail, /no concurrency target/)
    assert.deepEqual(rig.workerControl.calls, [], 'no adapter call is made without a target')
  })

  it('survives an unavailable worker-control adapter', async () => {
    const rig = new ScenarioRig({ workerControl: new UnavailableWorkerControlAdapter() })
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c'])
    hardware.set({ gpu_temp_c: 99 })
    await rig.advance(15 * MINUTE, 60)
    assert.ok(rig.history.length === 60)
    const applied = rig.decisions.filter((record) => record.action !== 'NO_ACTION')
    assert.ok(applied.length > 0, 'the decision is still taken')
    assert.ok(
      applied.every((record) => record.outcome.applied === false),
      'but it is reported as not applied',
    )
    assert.ok(applied.every((record) => record.outcome.capability === 'unavailable'))
  })

  it('records a decision for every applied action and explains it', async () => {
    const rig = new ScenarioRig()
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c'])
    hardware.set({ gpu_temp_c: 96 })
    await rig.advance(10 * MINUTE, 40)
    for (const record of rig.decisions) {
      assert.ok(record.id > 0)
      assert.ok(record.reasons.length > 0)
      assert.equal(typeof record.outcome.detail, 'string')
    }
    assert.deepEqual(
      rig.decisions.map((record) => record.id),
      [...rig.decisions.map((record) => record.id)].sort((a, b) => a - b),
      'audit ids are monotonic',
    )
  })

  it('does not emit a decision storm over a long run', async () => {
    const rig = new ScenarioRig({ config: { throttle: { concurrencyLimit: 2 } } })
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle'])
    hardware.set({ gpu_temp_c: 96, thermal_throttle: 0.7 })
    // Six simulated hours at a 15 s tick is 1440 evaluations of a machine that
    // never recovers. The scheduler must not re-apply its mitigation every time a
    // cooldown lapses: a level that is already in force is already in force.
    await drive(rig, { minutes: 360, tickMs: 15_000, onTick: () => hardware.set({ gpu_temp_c: 96, thermal_throttle: 0.7 }) })
    assert.equal(rig.history.length, 1440)
    const applied = rig.decisions.length
    assert.ok(applied <= 5, `expected a handful of decisions, saw ${applied}`)
    assert.ok(applied >= 1)
    const mitigationCalls = rig.workerControl.calls.filter(([name]) => name !== 'resumeNormalConcurrency')
    assert.ok(mitigationCalls.length <= 3, `expected one mitigation call, saw ${JSON.stringify(rig.workerControl.calls)}`)
  })

  it('starts and stops the periodic loop idempotently', async () => {
    const rig = new ScenarioRig({ config: { sampling: { intervalMs: 5 } } })
    rig.provider('hardware', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 40 })
    assert.equal(rig.scheduler.running, false)
    rig.scheduler.start()
    assert.equal(rig.scheduler.running, true)
    rig.scheduler.start()
    assert.equal(rig.scheduler.running, true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    rig.scheduler.stop()
    assert.equal(rig.scheduler.running, false)
    rig.scheduler.stop()
    assert.equal(rig.scheduler.running, false)
  })

  it('does not sample at all when disabled', async () => {
    const rig = new ScenarioRig({ config: { enabled: false } })
    const provider = rig.provider('hardware', 'hardware', ['cpu_temp_c'])
    provider.set({ cpu_temp_c: 99 })
    await rig.advance(MINUTE, 4)
    assert.equal(provider.samples, 0)
    assert.equal(rig.last.pressure, null)
    assert.deepEqual(rig.decisions, [])
  })

  it('reconfigures live without losing history', async () => {
    const rig = new ScenarioRig()
    rig.provider('hardware', 'hardware', ['gpu_temp_c']).set({ gpu_temp_c: 60 })
    await rig.advance(MINUTE, 4)
    const before = rig.last.metrics.gpu_temp_c
    rig.scheduler.reconfigure(resolveConfig({ preset: 'conservative' }))
    await rig.advance(MINUTE, 4)
    assert.equal(rig.last.metrics.gpu_temp_c, before)
    assert.equal(rig.scheduler.config.preset, 'conservative')
  })

  it('exposes per-window history for a metric', async () => {
    const rig = new ScenarioRig()
    rig.provider('hardware', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 55 })
    await rig.advance(MINUTE, 4)
    const windows = rig.scheduler.windowsFor('cpu_temp_c')
    assert.equal(windows.length, rig.config.windows.windowsMs.length)
    assert.ok(windows.every((entry) => entry.mean === 55))
  })

  it('ingests a sample directly and reports normalization violations', () => {
    const rig = new ScenarioRig()
    rig.scheduler.ingest({ provider: 'manual', timestamp: new Date(T0).toISOString(), metrics: { cpu_temp_c: 9000 } })
    assert.equal(rig.scheduler.normalizationViolations().length, 1)
    assert.equal(rig.scheduler.normalizationViolations()[0].reason, 'above_hard_max')
    assert.equal(rig.scheduler.trackedMetrics().includes('cpu_temp_c'), false)
  })

  it('contains a throwing event listener', async () => {
    const rig = new ScenarioRig()
    rig.scheduler.on('decision', () => {
      throw new Error('listener exploded')
    })
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c'])
    hardware.set({ gpu_temp_c: 97 })
    await rig.advance(10 * MINUTE, 40)
    assert.equal(rig.history.length, 40)
  })

  it('uses a registered safe point to gate the maintenance request', async () => {
    const safePoint = new ScriptedSafePoint('core', {
      safe: false,
      reason: 'git_commit_in_progress',
      estimatedState: 'busy',
    })
    const rig = new ScenarioRig({
      config: {
        maintenance: { enabled: true, targetTime: '04:00', windowStart: '03:30', windowEnd: '05:00' },
      },
      safePoints: [safePoint],
    })
    const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c', 'thermal_throttle'])
    hardware.set({ gpu_temp_c: 90, thermal_throttle: 0.4 })
    await drive(rig, { minutes: 60, tickMs: 30_000, maintenanceWindow: true, onTick: () => hardware.set({ gpu_temp_c: 90, thermal_throttle: 0.4 }) })

    const last = rig.last
    assert.equal(last.readiness.safe, false)
    assert.equal(last.readiness.reason, 'git_commit_in_progress')
    assert.ok(last.maintenance.windowOpen, 'the window is open but the safe point is not')
    assert.equal(rig.restart.applicationRequests.length, 0, 'no restart while the safe point refuses')
    assert.ok(last.state === STATES.maintenancePending || last.state === STATES.paused)
    assert.ok(safePoint.calls > 0)
  })
})

describe('DecisionLog', () => {
  function record(id, action = ACTIONS.throttle) {
    return {
      id,
      timestamp: new Date(T0 + id * 1000).toISOString(),
      action,
      state: STATES.throttled,
      pressure: 60,
      coverage: 0.5,
      drivers: [],
      reasons: ['pressure_60_gte_throttle_55'],
      outcome: { applied: true, capability: 'available', adapter: 'test', detail: 'ok' },
    }
  }

  it('keeps a bounded in-memory ring', () => {
    const log = new DecisionLog({ maxRecords: 3, directory: null, maxBytes: 1024 })
    for (let i = 1; i <= 5; i += 1) log.append(record(i))
    assert.equal(log.size, 3)
    assert.deepEqual(
      log.recent().map((entry) => entry.id),
      [3, 4, 5],
    )
    assert.deepEqual(
      log.recent(2).map((entry) => entry.id),
      [4, 5],
    )
    assert.equal(log.path, null)
  })

  it('writes and reads back a JSONL log with a schema version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-hs-log-'))
    try {
      const log = new DecisionLog({ maxRecords: 10, directory, maxBytes: 1024 * 1024 })
      log.append(record(1))
      log.append(record(2))
      assert.ok(existsSync(log.path))
      const lines = readFileSync(log.path, 'utf8').trim().split('\n')
      assert.equal(lines.length, 2)
      const parsed = JSON.parse(lines[0])
      assert.equal(parsed.schemaVersion, 1)
      assert.equal(parsed.kind, 'decision')
      assert.equal(parsed.record.id, 1)

      const reread = new DecisionLog({ maxRecords: 10, directory, maxBytes: 1024 * 1024 })
      const persisted = reread.readPersisted()
      assert.deepEqual(
        persisted.map((entry) => entry.id),
        [1, 2],
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('tolerates a truncated trailing line', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-hs-log-'))
    try {
      const log = new DecisionLog({ maxRecords: 10, directory, maxBytes: 1024 * 1024 })
      log.append(record(1))
      const path = log.path
      const content = readFileSync(path, 'utf8')
      // Simulate a hard kill mid-write.
      appendFileSync(path, '{"schemaVersion":1,"kind":"decision","recor')
      const reread = new DecisionLog({ maxRecords: 10, directory, maxBytes: 1024 * 1024 })
      assert.deepEqual(
        reread.readPersisted().map((entry) => entry.id),
        [1],
      )
      assert.ok(content.length > 0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('never throws when the log directory cannot be written', () => {
    const log = new DecisionLog({ maxRecords: 5, directory: '\0invalid\0', maxBytes: 1024 })
    log.append(record(1))
    assert.equal(log.writeFailures, 1)
    assert.ok(log.lastError !== null)
    assert.equal(log.size, 1, 'the in-memory ring still works')
  })

  it('rotates the file once it exceeds the size budget', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-hs-log-'))
    try {
      const log = new DecisionLog({ maxRecords: 100, directory, maxBytes: 200 })
      for (let i = 1; i <= 6; i += 1) log.append(record(i))
      const rotated = readdirSync(directory).filter((name) => name.endsWith('.bak'))
      assert.ok(rotated.length >= 1, `expected a rotated file, saw ${JSON.stringify(readdirSync(directory))}`)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('scheduler clock discipline', () => {
  it('never samples faster than the configured interval when running', async () => {
    const rig = new ScenarioRig({ config: { sampling: { intervalMs: 10 } } })
    const provider = rig.provider('hardware', 'hardware', ['cpu_temp_c'])
    provider.set({ cpu_temp_c: 40 })
    rig.scheduler.start()
    await new Promise((resolve) => setTimeout(resolve, 55))
    rig.scheduler.stop()
    assert.ok(provider.samples >= 2, `expected at least two samples, saw ${provider.samples}`)
    assert.ok(provider.samples <= 12, `expected bounded sampling, saw ${provider.samples}`)
  })

  it('keeps the last tick instant', async () => {
    const rig = new ScenarioRig()
    rig.provider('hardware', 'hardware', ['cpu_temp_c']).set({ cpu_temp_c: 40 })
    await rig.advance(5 * MINUTE, 5)
    assert.equal(rig.scheduler.lastTickMs, rig.now)
  })

  it('reports uptime-derived time pressure through the runtime provider', async () => {
    const rig = new ScenarioRig()
    rig.provider('runtime', 'runtime', ['uptime_seconds']).set({ uptime_seconds: 10 * 24 * 3600 })
    await rig.advance(MINUTE, 4)
    const time = rig.last.dimensions.find((dimension) => dimension.dimension === 'time')
    assert.ok(time.score !== null && time.score > 50, `time dimension scored ${time.score}`)
    assert.ok(rig.last.drivers.some((driver) => driver.code === 'uptime_pressure'))
  })

  it('reads process uptime fresh on every sample, so the time dimension can actually rise', async () => {
    const { defaultEnvironment } = await import('../lib/providers/environment.js')
    const environment = defaultEnvironment()
    const first = environment.process.uptimeSeconds
    // The process facade has to be a read-through, not a snapshot taken at construction:
    // a frozen uptime would pin the `time` dimension — weight 0.15 and the design's
    // long-uptime maintenance driver — at whatever value the process had when the plugin
    // loaded, forever.
    await new Promise((resolve) => setTimeout(resolve, 60))
    const second = environment.process.uptimeSeconds
    assert.ok(
      second > first,
      `uptime did not advance: ${first} -> ${second}. The process facade is being snapshotted.`,
    )
  })

  it('acknowledges a system reboot only on the rung that reboots', async () => {
    const rig = new ScenarioRig({
      config: {
        thresholds: {
          throttle: { enter: 5, exit: 2 },
          pause_new_work: { enter: 25, exit: 20 },
          request_app_restart: { enter: 40, exit: 35 },
          request_system_reboot: { enter: 90, exit: 85 },
        },
        antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 },
        maintenance: { enabled: true, safePointRequired: false },
      },
    })
    try {
      const hardware = rig.provider('hardware', 'hardware', ['gpu_temp_c'])
      hardware.set({ gpu_temp_c: 60 })
      await rig.advance(MINUTE, 2)
      // 96 °C saturates the 78..92 band, so the lone measured dimension renormalizes to
      // 100 and the *top* rung is what fires — which is the rung whose acknowledgement
      // this test is about. The band carries a 60 s sustain gate, so the condition has to
      // hold that long before it scores at all.
      hardware.set({ gpu_temp_c: 96 })
      await rig.advance(2 * MINUTE, 10)
      assert.equal(rig.last.pressure, 100, 'the saturated lone metric should read 100')
      // The request is raised on the tick the pressure crosses the top rung, so by the end
      // of the window the state has already moved on to waiting for a safe point.
      assert.ok(
        ['REQUEST_SYSTEM_REBOOT', 'ESCALATION_PENDING'].includes(rig.last.state),
        `state was ${rig.last.state}`,
      )
      assert.ok(
        rig.restart.requests.some((request) => request.mode === 'system'),
        `expected a system restart request, saw ${JSON.stringify(rig.restart.requests.map((r) => r.mode))}`,
      )

      assert.ok(rig.restart.requests.length > 0, 'the scenario should have produced a restart request')
      for (const request of rig.restart.requests) {
        if (request.mode === 'system') {
          assert.equal(
            request.acknowledgeSystemReboot,
            true,
            'a system request must acknowledge the reboot, or the restart plugin refuses it with SYSTEM_REBOOT_NOT_PERMITTED',
          )
        } else {
          assert.equal(
            request.acknowledgeSystemReboot,
            undefined,
            'an application request must never carry the reboot acknowledgement',
          )
        }
      }
    } finally {
      rig.scheduler.stop()
    }
  })

  it('does not consult a safe point at all when the configuration says it is not required', async () => {
    const rig = new ScenarioRig({
      config: {
        thresholds: {
          throttle: { enter: 5, exit: 2 },
          pause_new_work: { enter: 10, exit: 6 },
          request_app_restart: { enter: 15, exit: 12 },
          request_system_reboot: { enter: 101, exit: 99 },
        },
        antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 },
        maintenance: { enabled: true, safePointRequired: false },
      },
    })
    try {
      // An empty registry answers `safe: null` when asked, and the policy engine treats
      // that as unsafe. `safePointRequired: false` therefore has to mean the gate is
      // skipped, not that the question is asked and answered badly — otherwise the
      // setting blocks every restart instead of enabling one.
      rig.provider('hardware', 'hardware', ['gpu_temp_c']).set({ gpu_temp_c: 96 })
      await rig.advance(2 * MINUTE, 10)
      assert.equal(rig.last.pressure, 100, 'the saturated lone metric should read 100')

      assert.ok(
        rig.restart.applicationRequests.length > 0,
        `expected an application restart request, saw none; state ${rig.last.state}, pressure ${rig.last.pressure}, warnings ${JSON.stringify(rig.last.warnings)}`,
      )

      assert.equal(rig.last.readiness.reason, 'not_evaluated')
      for (const record of rig.decisions) {
        assert.equal(
          record.reasons.some((reason) => reason.startsWith('safe_point_unsafe') || reason === 'safe_point_unknown'),
          false,
          `a skipped gate must not appear as a block: ${record.reasons.join(', ')}`,
        )
      }
    } finally {
      rig.scheduler.stop()
    }
  })
})
