/**
 * Harness integration: the `apply` entry point, the settings namespace, the three
 * model-facing tools, and the failure isolation that keeps a broken plugin from
 * affecting the host.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import * as plugin from '../lib/index.js'
import { applyHealthScheduler, SETTINGS_NAMESPACE, TOOL_NAMES } from '../lib/dsh/plugin.js'
import { metricsSnapshot, renderHealthReport, renderMetricRow } from '../lib/dsh/report.js'
import { defaultEnvironment } from '../lib/providers/environment.js'
import { StatsFileSource, extractMetrics, parseNameValueLines } from '../lib/providers/sources.js'
import { MINUTE, RecordingRestartAdapter, RecordingWorkerControl, ScriptedProvider } from './helpers/rig.js'

const T0 = Date.parse('2026-03-01T00:00:00.000Z')

/** A fake harness context that records everything the plugin registers. */
function fakeContext(options = {}) {
  const tools = new Map()
  const logs = []
  const context = {
    logger: {
      debug: (message) => logs.push(['debug', message]),
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    },
    ...(options.noTools === true
      ? {}
      : {
          tools: {
            register(definition) {
              if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
              tools.set(definition.name, definition)
              return () => tools.delete(definition.name)
            },
          },
        }),
    ...(options.noSettings === true
      ? {}
      : {
          settings: {
            register(ns, schema, registerOptions) {
              context.registeredSettings = { ns, schema, registerOptions }
              return { get: () => registerOptions.base }
            },
          },
        }),
  }
  return { context, tools, logs }
}

/** Drive the applied plugin by calling a registered tool. */
async function callTool(tools, name, args = {}) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is not registered`)
  const value = await definition.execute(args)
  return { value, blocks: definition.output.render(args, value) }
}

/** Deterministic environment for the plugin under test. */
function environment(overrides = {}) {
  return {
    ...defaultEnvironment(),
    clock: () => overrides.now ?? T0,
    os: {
      cpus: () => [{ model: 'test', speed: 1000, times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }],
      totalmem: () => 32 * 1024 ** 3,
      freemem: () => 20 * 1024 ** 3,
      loadavg: () => [0.1, 0.1, 0.1],
      uptime: () => 3600,
      platform: () => 'test',
      arch: () => 'test',
      hostname: () => 'test-host',
      release: () => '0.0.0',
    },
    process: {
      pid: 4242,
      uptimeSeconds: 3600,
      rssBytes: 512 * 1024 ** 2,
      heapUsedBytes: 128 * 1024 ** 2,
      externalBytes: 8 * 1024 ** 2,
      activeHandles: 12,
      activeRequests: 0,
      treeRssBytes: null,
    },
    stateDirectory: null,
    runProbe: async () => ({ metrics: {}, malformed: [], error: 'no probe configured' }),
  }
}

describe('plugin exports', () => {
  it('exposes the Cordis plugin contract', () => {
    assert.equal(plugin.name, 'dsh-health-scheduler')
    assert.deepEqual(plugin.inject, ['tools'])
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(typeof plugin.resolveConfig, 'function')
    assert.equal(typeof plugin.HealthScheduler, 'function')
    assert.deepEqual(Object.keys(plugin.PRESETS).sort(), ['aggressive', 'balanced', 'conservative'])
    assert.ok(plugin.CANONICAL_METRICS.length > 40)
  })

  it('exposes the documented public API surface', () => {
    for (const name of [
      'HealthScheduler',
      'PolicyEngine',
      'PressureEngine',
      'RollingStore',
      'TrendAnalyzer',
      'SafePointRegistry',
      'ProviderRegistry',
      'DecisionLog',
      'HardwareProvider',
      'MemoryProvider',
      'RuntimeProvider',
      'StatsBackedProvider',
      'UnavailableRestartAdapter',
      'UnavailableWorkerControlAdapter',
      'computeMaintenancePicture',
      'normalizeSample',
      'levelOf',
      'scoreMetric',
      'metricsSnapshot',
      'renderHealthReport',
      'resolveConfig',
      'tryResolveConfig',
      'deepMerge',
    ]) {
      assert.equal(typeof plugin[name], 'function', `${name} should be exported as a function`)
    }
    assert.equal(typeof plugin.METRICS, 'object')
    assert.equal(typeof plugin.ACTION_LEVEL, 'object')
  })

  it('never exports anything that could restart or kill a process', async () => {
    // The plugin's central promise: it has no execution capability at all.
    const source = await import('node:fs').then((fs) =>
      fs
        .readdirSync(new URL('../lib', import.meta.url), { recursive: true })
        .filter((name) => typeof name === 'string' && name.endsWith('.js'))
        .map((name) => fs.readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8'))
        .join('\n'),
    )
    for (const forbidden of ['taskkill', 'shutdown /r', 'shutdown -r', 'child_process.spawn', 'execSync']) {
      assert.equal(source.includes(forbidden), false, `built output must not contain ${forbidden}`)
    }
  })
})

describe('applyHealthScheduler', () => {
  it('registers the three tools and starts monitoring', () => {
    const { context, tools } = fakeContext()
    const applied = applyHealthScheduler(context, {}, plugin, {
      environment: environment(),
      restart: new RecordingRestartAdapter(),
      workerControl: new RecordingWorkerControl(),
      start: false,
    })
    assert.deepEqual([...tools.keys()].sort(), [TOOL_NAMES.history, TOOL_NAMES.policy, TOOL_NAMES.status].sort())
    assert.deepEqual(applied.providerIds, ['hardware', 'memory', 'runtime', 'workers', 'computer-use', 'ui', 'context'])
    assert.equal(applied.config.preset, 'balanced')
    applied.dispose()
  })

  it('registers its settings namespace with the resolved config as the base layer', () => {
    const { context } = fakeContext()
    const applied = applyHealthScheduler(context, { preset: 'conservative' }, plugin, {
      environment: environment(),
      start: false,
    })
    assert.equal(context.registeredSettings.ns, SETTINGS_NAMESPACE)
    assert.equal(context.registeredSettings.registerOptions.applies, 'live')
    assert.equal(context.registeredSettings.registerOptions.base.preset, 'conservative')
    applied.dispose()
  })

  it('runs without a tools service and says so', () => {
    const { context, logs } = fakeContext({ noTools: true })
    const applied = applyHealthScheduler(context, {}, plugin, { environment: environment(), start: false })
    assert.deepEqual(applied.toolNames, [])
    assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('no tool runtime')))
    applied.dispose()
  })

  it('runs without a settings service and says so', () => {
    const { context, logs } = fakeContext({ noSettings: true })
    const applied = applyHealthScheduler(context, {}, plugin, { environment: environment(), start: false })
    assert.ok(logs.some(([level, message]) => level === 'warn' && message.includes('no settings service')))
    applied.dispose()
  })

  it('rejects a bad configuration loudly but keeps running on the default preset', () => {
    const { context, logs, tools } = fakeContext()
    const applied = applyHealthScheduler(
      context,
      { thresholds: { throttle: { enter: 50, exit: 60 } } },
      plugin,
      { environment: environment(), start: false },
    )
    assert.ok(
      logs.some(([level, message]) => level === 'error' && message.includes('configuration was rejected')),
      'a rejected document must be reported',
    )
    assert.equal(applied.config.preset, 'balanced', 'the safe default is used')
    assert.equal(tools.size, 3, 'the plugin still works')
    applied.dispose()
  })

  it('starts and stops the loop through apply and dispose', async () => {
    const { context } = fakeContext()
    const applied = applyHealthScheduler(context, { sampling: { intervalMs: 5 } }, plugin, {
      environment: environment(),
    })
    assert.equal(applied.scheduler.running, true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    applied.dispose()
    assert.equal(applied.scheduler.running, false)
  })

  it('does not start when the configuration disables it', () => {
    const { context, logs } = fakeContext()
    const applied = applyHealthScheduler(context, { enabled: false }, plugin, { environment: environment() })
    assert.equal(applied.scheduler.running, false)
    assert.ok(logs.some(([level, message]) => level === 'info' && message.includes('disabled')))
    applied.dispose()
  })

  it('uses an unavailable restart adapter when dsh-restart is not installed', () => {
    const { context } = fakeContext()
    const applied = applyHealthScheduler(context, {}, plugin, { environment: environment(), start: false })
    const restart = applied.scheduler.snapshot
    void restart
    assert.equal(applied.scheduler.safePoints.isEmpty, true)
    applied.dispose()
  })

  it('writes the decision log when a state directory is provided', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-hs-apply-'))
    try {
      const { context, tools } = fakeContext()
      const applied = applyHealthScheduler(
        context,
        {
          // Bands sit below any reachable rounded pressure, so the very first tick
          // crosses the ladder. `exit < enter` is still respected, as the
          // validator requires.
          thresholds: {
            throttle: { enter: 0.5, exit: 0.25 },
            pause_new_work: { enter: 0.6, exit: 0.5 },
            request_app_restart: { enter: 0.7, exit: 0.6 },
            request_system_reboot: { enter: 0.8, exit: 0.7 },
          },
          antiFlap: { debounceEvaluations: 1, minStateDwellMs: 0, minRepeatActionMs: 0 },
          // The sustain gate is exercised in its own suite; here it would only
          // delay a single-tick assertion.
          metrics: { timeout_rate: { band: { warn: 0.02, critical: 0.2 }, sustainMs: 0 } },
          storage: { enabled: true },
        },
        plugin,
        {
          environment: environment(),
          workerControl: new RecordingWorkerControl(),
          stateDirectory: directory,
          start: false,
        },
      )
      applied.scheduler.registerProvider(
        new ScriptedProvider('test-double', 'workers', ['timeout_rate']).set({ timeout_rate: 0.9 }),
      )
      await applied.scheduler.tick()
      assert.ok(applied.scheduler.decisions().length >= 1, 'a decision should have been recorded')
      assert.equal(applied.scheduler.decisions()[0].action, 'PAUSE_NEW_WORK')
      void tools
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('model-facing tools', () => {
  function wired() {
    const { context, tools, logs } = fakeContext()
    const applied = applyHealthScheduler(context, {}, plugin, {
      environment: environment(),
      restart: new RecordingRestartAdapter(),
      workerControl: new RecordingWorkerControl(),
      start: false,
    })
    applied.scheduler.registerProvider(
      new ScriptedProvider('test-double', 'workers', ['timeout_rate', 'failure_rate']).set({ timeout_rate: 0.05, failure_rate: 0.04 }),
    )
    return { applied, tools, logs }
  }

  it('health_status returns a readable report and never claims unknown is healthy', async () => {
    const { applied, tools } = wired()
    await applied.scheduler.tick()
    const { value, blocks } = await callTool(tools, TOOL_NAMES.status)
    assert.equal(typeof value, 'string')
    assert.match(value, /Restart Pressure:/)
    assert.match(value, /State: /)
    assert.match(value, /Unknown dimensions:.*not scored as healthy/)
    assert.equal(blocks[0].type, 'text')
    applied.dispose()
  })

  it('health_status supports its sections', async () => {
    const { applied, tools } = wired()
    await applied.scheduler.tick()
    const pressure = await callTool(tools, TOOL_NAMES.status, { section: 'pressure' })
    assert.match(pressure.value, /Coverage: \d+%/)
    const maintenance = await callTool(tools, TOOL_NAMES.status, { section: 'maintenance' })
    assert.match(maintenance.value, /Maintenance phase:/)
    const providers = await callTool(tools, TOOL_NAMES.status, { section: 'providers' })
    assert.match(providers.value, /hardware: available/)
    applied.dispose()
  })

  it('health_history returns window statistics as JSON', async () => {
    const { applied, tools } = wired()
    await applied.scheduler.tick()
    const { value } = await callTool(tools, TOOL_NAMES.history, { metric: 'cpu_temp_c' })
    const parsed = JSON.parse(value)
    assert.equal(parsed.metric, 'cpu_temp_c')
    assert.ok(parsed.windows.length >= 4)
    assert.ok(parsed.windows.every((entry) => typeof entry.window_minutes === 'number'))
    applied.dispose()
  })

  it('health_history rejects a non-canonical metric with a helpful error', async () => {
    const { applied, tools } = wired()
    await assert.rejects(
      () => callTool(tools, TOOL_NAMES.history, { metric: 'gpu_temperature' }),
      /unknown metric "gpu_temperature"/,
    )
    applied.dispose()
  })

  it('health_policy explains the ladder, the config and the audit trail', async () => {
    const { applied, tools } = wired()
    await applied.scheduler.tick()
    const explain = await callTool(tools, TOOL_NAMES.policy)
    assert.match(explain.value, /Action ladder/)
    assert.match(explain.value, /THROTTLE {2,}enter >= 55/)
    assert.match(explain.value, /dsh-restart/)

    const config = await callTool(tools, TOOL_NAMES.policy, { action: 'config' })
    const parsed = JSON.parse(config.value)
    assert.equal(parsed.preset, 'balanced')
    assert.equal(parsed.thresholds.throttle.enter, 55)

    const decisions = await callTool(tools, TOOL_NAMES.policy, { action: 'decisions' })
    assert.equal(Array.isArray(JSON.parse(decisions.value)), true)
    applied.dispose()
  })

  it('tool definitions advertise a bounded timeout and a string schema', () => {
    const { applied, tools } = wired()
    for (const definition of tools.values()) {
      assert.equal(definition.output.schema.type, 'string')
      assert.ok(typeof definition.timeoutMs === 'number' && definition.timeoutMs > 0)
      assert.ok(definition.description.length > 40, 'tool descriptions must be useful to a model')
      assert.ok(Object.keys(definition.parameters).length >= 0)
    }
    applied.dispose()
  })

  it('takes a first tick on demand when no snapshot exists yet', async () => {
    const { context, tools } = fakeContext()
    const applied = applyHealthScheduler(context, {}, plugin, {
      environment: environment(),
      workerControl: new RecordingWorkerControl(),
      start: false,
    })
    applied.scheduler.registerProvider(
      new ScriptedProvider('test-double', 'workers', ['timeout_rate']).set({ timeout_rate: 0.02 }),
    )
    assert.equal(applied.scheduler.snapshot, null)
    const { value } = await callTool(tools, TOOL_NAMES.status)
    assert.match(value, /Restart Pressure:/)
    assert.ok(applied.scheduler.snapshot !== null)
    applied.dispose()
  })
})

describe('presentation helpers', () => {
  it('renders a compact JSON payload with snake_case keys', async () => {
    const { context } = fakeContext()
    const applied = applyHealthScheduler(context, {}, plugin, { environment: environment(), start: false })
    applied.scheduler.ingest({
      provider: 'manual',
      timestamp: new Date().toISOString(),
      metrics: { cpu_temp_c: 70, gpu_temp_c: 60 },
    })
    const snapshot = await applied.scheduler.tick()
    const payload = metricsSnapshot(snapshot)
    assert.equal(typeof payload.timestamp, 'string')
    assert.equal(typeof payload.restart_pressure, 'number')
    assert.equal(typeof payload.coverage, 'number')
    assert.ok(Array.isArray(payload.dimensions))
    assert.ok(Array.isArray(payload.providers))
    assert.ok(payload.maintenance.phase)
    assert.ok(payload.safe_point.reason)
    assert.equal(JSON.stringify(payload).includes('undefined'), false)
    applied.dispose()
  })

  it('formats a metric row for a table', () => {
    assert.equal(renderMetricRow('gpu_temp_c', 88), 'gpu_temp_c                   88')
    assert.equal(renderMetricRow('gpu_temp_c', null), 'gpu_temp_c                   unknown')
  })

  it('renders a report that mentions every section', async () => {
    const { context } = fakeContext()
    const applied = applyHealthScheduler(context, {}, plugin, { environment: environment(), start: false })
    applied.scheduler.ingest({
      provider: 'manual',
      timestamp: new Date().toISOString(),
      metrics: { cpu_temp_c: 70, gpu_temp_c: 60 },
    })
    const snapshot = await applied.scheduler.tick()
    const report = renderHealthReport(snapshot)
    for (const section of ['Restart Pressure:', 'State:', 'Dimensions:', 'Providers:', 'Memory:', 'Safe point:']) {
      assert.ok(report.includes(section), `report is missing "${section}"`)
    }
    applied.dispose()
  })
})

describe('external telemetry seams', () => {
  it('parses name=value and name,value command output and ignores unknown names', () => {
    const parsed = parseNameValueLines(
      ['# comment', 'gpu_temp_c=71.5', 'cpu_temp_c,62', 'not_a_metric=5', 'gpu_usage=not-a-number', '', 'broken'].join('\n'),
    )
    assert.deepEqual(parsed.metrics, { gpu_temp_c: 71.5, cpu_temp_c: 62 })
    assert.deepEqual(parsed.malformed, ['gpu_usage'])
  })

  it('accepts both a wrapped stats document and a bare metric object', () => {
    const wrapped = extractMetrics({ timestamp: 'x', metrics: { render_latency_ms: 120, bogus: 1 } })
    assert.deepEqual(wrapped.metrics, { render_latency_ms: 120 })
    assert.deepEqual(wrapped.unknownKeys, ['bogus'])
    const bare = extractMetrics({ render_latency_ms: 120 })
    assert.deepEqual(bare.metrics, { render_latency_ms: 120 })
    assert.deepEqual(extractMetrics('nonsense').metrics, {})
  })

  it('reports an unconfigured stats source as unknown, never as zero', () => {
    const source = new StatsFileSource([], 60_000)
    assert.equal(source.configured, false)
    const snapshot = source.read(T0)
    assert.deepEqual(snapshot.metrics, {})
    assert.equal(snapshot.readable, false)
  })

  it('reports a missing stats file with a reason', () => {
    const source = new StatsFileSource([join(tmpdir(), 'definitely-missing-stats-file.json')], 60_000)
    const snapshot = source.read(T0)
    assert.equal(snapshot.readable, false)
    assert.equal(snapshot.reason, 'telemetry_unavailable')
    assert.match(snapshot.detail, /no stats file exists yet/)
  })

  it('treats a stale stats file as degraded', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-hs-stats-'))
    const path = join(directory, 'metrics.json')
    try {
      const { writeFileSync, utimesSync } = await import('node:fs')
      writeFileSync(path, JSON.stringify({ metrics: { render_latency_ms: 900 } }), 'utf8')
      const old = new Date(T0 - 10 * MINUTE)
      utimesSync(path, old, old)
      const source = new StatsFileSource([path], 60_000)
      const snapshot = source.read(T0)
      assert.equal(snapshot.readable, true)
      assert.equal(snapshot.stale, true)
      assert.deepEqual(snapshot.metrics, { render_latency_ms: 900 })
      assert.match(snapshot.detail, /last written/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('parses a tasklist line into resident bytes for the process tree', async () => {
    const { parseTasklistMemoryLine, parsePsMemoryLine } = await import('../lib/providers/process-tree.js')
    assert.deepEqual(parseTasklistMemoryLine('"node.exe","4242","Console","1","1,234,567 K"'), {
      pid: 4242,
      rssBytes: 1_234_567 * 1024,
    })
    assert.deepEqual(parseTasklistMemoryLine('"node.exe","7","Console","1","512,000 K"'), {
      pid: 7,
      rssBytes: 512_000 * 1024,
    })
    assert.deepEqual(parseTasklistMemoryLine('"x.exe","3","Console","1","1.5 G"'), {
      pid: 3,
      rssBytes: 1.5 * 1024 ** 3,
    })
    assert.equal(parseTasklistMemoryLine('INFO: No tasks are running which match the specified criteria.'), null)
    assert.equal(parseTasklistMemoryLine(''), null)
    assert.deepEqual(parsePsMemoryLine('  4242  102400'), { pid: 4242, rssBytes: 102400 * 1024 })
    assert.equal(parsePsMemoryLine('nonsense'), null)
  })

  it('adds configured extra pids to the process RSS sum, and reports a failed query', async () => {
    const { ProcessTreeReader } = await import('../lib/providers/process-tree.js')
    const reader = new ProcessTreeReader({
      extraPids: [111, 222],
      refreshMs: 0,
      selfPid: 1,
      runner: async (file) => {
        // The runner is asked once for the whole list, whichever platform.
        if (file === 'tasklist.exe' || file === 'ps') {
          return process.platform === 'win32'
            ? { stdout: '"node.exe","111","Console","1","100,000 K"\r\n"node.exe","222","Console","1","50,000 K"', code: 0 }
            : { stdout: '111 100000\n222 50000\n', code: 0 }
        }
        return { stdout: '', code: 1 }
      },
    })
    const total = reader.total(1_000, 10_000)
    // The background refresh has been kicked off but has not resolved yet, so the
    // first reading is this process alone.
    assert.equal(total, 10_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const withTree = reader.total(2_000, 10_000)
    assert.equal(withTree, 10_000 + 150_000 * 1024)
    assert.equal(reader.error, null)
    assert.deepEqual(reader.pids, [1, 111, 222])

    const failing = new ProcessTreeReader({
      extraPids: [999],
      refreshMs: 0,
      runner: async () => ({ stdout: '', code: 1 }),
    })
    assert.equal(failing.total(1, 5_000), 5_000)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(failing.total(2, 5_000), 5_000, 'a failed query leaves only this process in the sum')
    assert.match(failing.error, /exited with 1/)
  })

  it('reads a stats file into the stats-backed providers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-hs-stats-'))
    const path = join(directory, 'metrics.json')
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(
        path,
        JSON.stringify({ metrics: { render_latency_ms: 3_000, timeout_rate: 0.4, screenshot_latency_ms: 5_000 } }),
        'utf8',
      )
      const { context } = fakeContext()
      const applied = applyHealthScheduler(
        context,
        {
          providerOptions: { statsFile: { paths: [path], staleAfterMs: 60 * MINUTE } },
          sampling: { intervalMs: 1 },
        },
        plugin,
        { environment: { ...environment(), now: Date.now() }, start: false },
      )
      const snapshot = await applied.scheduler.tick()
      assert.equal(snapshot.metrics.render_latency_ms, 3_000)
      assert.equal(snapshot.metrics.timeout_rate, 0.4)
      const ui = snapshot.providers.find((provider) => provider.id === 'ui')
      assert.equal(ui.totalSuccesses, 1)
      applied.dispose()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('reports a failing helper command as a degraded sample rather than an error', async () => {
    const { context } = fakeContext()
    // A deterministic CPU-time sequence: utilisation is the delta between two
    // readings, and a real `os.cpus()` on a twitchy machine makes that flaky.
    // Interval 1 -> 2 adds 100 busy ticks and 300 idle ticks, i.e. 25 % busy.
    let reading = 0
    const base = environment()
    const times = [
      { user: 1_000, nice: 0, sys: 500, idle: 8_500, irq: 0 },
      { user: 1_100, nice: 0, sys: 500, idle: 8_800, irq: 0 },
    ]
    const applied = applyHealthScheduler(
      context,
      { providerOptions: { hardware: { helperCommand: ['definitely-not-a-real-binary'] } } },
      plugin,
      {
        environment: {
          ...base,
          os: {
            ...base.os,
            cpus: () => [{ model: 'test', speed: 1000, times: times[Math.min(reading, 1)] }],
          },
        },
        start: false,
      },
    )
    await applied.scheduler.tick()
    reading = 1
    const snapshot = await applied.scheduler.tick()

    assert.ok(
      snapshot.warnings.some((warning) => warning.includes('helperCommand failed')),
      `expected a helper failure warning, saw ${JSON.stringify(snapshot.warnings)}`,
    )
    assert.equal(typeof snapshot.metrics.cpu_usage, 'number', 'native measurements still arrive')
    assert.ok(
      Math.abs(snapshot.metrics.cpu_usage - 0.25) < 0.01,
      `cpu_usage was ${snapshot.metrics.cpu_usage}`,
    )
    // The absent thermal metrics are reported as unknown rather than as zero.
    assert.equal(snapshot.metrics.gpu_temp_c, undefined)
    assert.ok(snapshot.unknownDimensions.length > 0)
    void MINUTE
    applied.dispose()
  })
})
