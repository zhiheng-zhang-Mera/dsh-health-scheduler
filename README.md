# dsh-health-scheduler

English | [中文](README.zh.md)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20.11.0-brightgreen.svg)
![DSH](https://img.shields.io/badge/DSH-cordis%20%5E4.0.1-6f42c1.svg)
![Plugin type](https://img.shields.io/badge/type-DSH%20bundle%20plugin-orange.svg)

**Health monitoring, restart-pressure scoring, maintenance scheduling and action
decisions for DeepSeek Harness — it never restarts anything itself.**

`dsh-health-scheduler` watches a DS-Hns machine, reduces everything it can measure to a
single `restart_pressure` number between 0 and 100, decides what *should* happen next, and
then asks somebody else to do it. Levels 1 and 2 of its action ladder are handed to a
worker-control adapter; levels 3 and 4 are **requests** posted to the separate
[`dsh-restart`](https://github.com/zhiheng-zhang-Mera/dsh-restart) bundle, which owns restart
execution.

The pipeline is one direction only:

```text
providers -> normalization -> rolling windows -> trend -> pressure -> policy
          -> maintenance scheduler -> action adapters (worker control | restart request)
```

## What it is / What it is not

| Concern | Owner | This plugin's role |
| --- | --- | --- |
| Sensing device and runtime health | **Health Scheduler** | Owns it. Providers sample, normalize and retain history. |
| Judging how bad things are | **Health Scheduler** | Owns it. The pressure model and the policy engine live here. |
| Scheduling maintenance | **Health Scheduler** | Owns it. Window, target, deferral budget, safe point. |
| Reducing load (`THROTTLE`, `PAUSE_NEW_WORK`) | **Health Scheduler** | Requests it through the worker-control adapter. |
| Actually restarting anything | `dsh-restart` | **Does not own it.** Emits a request and reads the answer. |
| Restart locks, rate limits, checkpoints, graceful shutdown | `dsh-restart` | Not here. |
| Relaunching after a crash, crash-loop breaker | Supervisor | Not here. |
| Task state, checkpoints, resume | DS-Hns Core | Not here. The safe-point query is a *question*, not storage. |
| A second Mega Core | nobody | Explicitly out of scope. |

Three promises follow from that table, and they are load-bearing:

1. **No restart execution.** There is no `taskkill`, no `reboot`, no process kill, no
   `child_process` call that could reach the operating system's restart path. The only
   `execFile` in the codebase runs a *configured telemetry probe* (`src/providers/sources.ts`).
2. **Missing telemetry is `unknown`, never healthy.** A dimension with no data scores
   `null`, and its nominal weight is redistributed over the dimensions that do have data.
3. **A single point sample never drives a high-risk action.** Every scored metric passes a
   sustain gate, every metric has a rolling window behind it, and the two highest rungs of
   the ladder are additionally debounced, gated on the maintenance window and gated on a
   safe point.

## Install

`dsh plugin --profile <name> <pnpm args>` forwards its remaining arguments to `pnpm`
inside the profile directory and then reconciles the profile's bundle list, so an
installed package that declares `dsh.bundle` joins the layer stack automatically.

From a local checkout of this repository:

```sh
# Windows PowerShell, from the checkout directory
dsh plugin --profile web add <path-to-checkout>\dsh-health-scheduler
```

```sh
# any platform, from the checkout directory (a bare "." is anchored to your cwd)
cd dsh-health-scheduler
dsh plugin --profile web add .
```

From a package name or a tarball:

```sh
dsh plugin --profile web add dsh-health-scheduler
dsh plugin --profile web add ./dsh-health-scheduler-0.1.0.tgz
```

### Verify before booting

`--dump-config` prints the composed profile tree without booting it. Use it to confirm
that the plugin row is present and that its configuration is what you wrote:

```sh
dsh --profile web --dump-config
```

`--dump-default-config` prints the same tree *without* your user layer and without any
`--patch` overlays, which makes it the fastest way to see what this plugin contributes.

### Boot

```sh
dsh --profile web
```

`dsh web` is a hardcoded alias for `--profile web`.

### The git-install caveat

A git-hosted plugin builds on install through its `prepare` script, and pnpm blocks that
build until you allow it. When `dsh plugin ... add git+https://…` fails, the CLI prints the
exact key pnpm wants; add it under `allowBuilds` in
`<profile directory>/pnpm-workspace.yaml` and re-run the same command.

This plugin ships `"prepack": "npm run build"`, so:

- **Installing from npm or a tarball needs no build permission.** The published tarball
  already contains `lib/`.
- **Installing from a git URL needs the `allowBuilds` entry**, because `prepare`/`prepack`
  must run `tsc` before `lib/` exists.
- **Installing from a local path** behaves like a tarball when `lib/` is already built, and
  needs a build step otherwise.

## Quick start

The plugin works with no configuration at all — the `balanced` preset is the default and
every leaf in it is a default, not a law. A minimal useful document is one line:

```jsonc
// profile package.json -> dsh.profile, or the plugin's settings namespace
{ "preset": "balanced" }
```

A more realistic first configuration turns on the scheduled maintenance window and points
the hardware provider at a thermal helper:

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: health-scheduler
  name: dsh-health-scheduler
  config:
    preset: balanced
    maintenance:
      enabled: true
      targetTime: '04:00'
      windowStart: '03:30'
      windowEnd: '05:00'
      maxDeferMs: 3600000
      urgentOverridePressure: 92
      safePointRequired: true
    providerOptions:
      hardware:
        helperCommand: ['powershell', '-NoProfile', '-File', 'C:\\dsh\\gpu-temp.ps1']
        helperTimeoutMs: 5000
      statsFile:
        paths: ['C:\\dsh\\telemetry\\metrics.json']
        staleAfterMs: 120000
```

After a boot the plugin logs

```text
health-scheduler: monitoring started (7 providers, interval 15000 ms, preset balanced)
```

and on demand the read-only health report begins like this:

```text
Restart Pressure: 21 / 100
State: THROTTLED
Primary Cause: gpu_usage=95.00 pp scores 89/100, held 1260s
Telemetry coverage: 60%
Unknown dimensions: runtime, worker, computer_use_ui (not scored as healthy)
Maintenance: next window 03:30-05:00
Safe point: no safe-point source registered; readiness unknown
Capabilities: restart=unavailable, worker-control=unavailable
```

Every number there is traceable to a metric. There is no sentence in the output that is not
backed by a measurement — "the model thought it should restart" is not a possible reason
code.

## How it works

### 1. Providers sample; nothing else touches the outside world

All health data enters through a `HealthProvider`. The pressure model and the policy engine
are forbidden from reaching for NVML, LibreHardwareMonitor, HWiNFO, a Windows API, worker
internals or Electron internals. A provider that cannot measure a metric **omits the key**;
absence is the only way to say "unknown", and it is deliberately not spelled `0`.

### 2. Normalization rejects, clamps and sorts

`normalizeSample` turns a raw sample into the canonical vocabulary. A reading that is not a
finite number, or that is outside the metric's hard physical bound, is dropped and reported
as a violation. A `ratio` sent as a percentage (`1.0 < v <= 1.5`) is clamped to `1` with a
violation attached rather than silently accepted. The surviving bag is sorted by metric name
so snapshots are stable.

### 3. Rolling windows, not points

Every metric keeps raw samples for `windows.rawMs` (30 minutes by default, raised to the
longest statistics window if that is longer) and one mean/max/min bucket per
`windows.aggregateBucketMs` (5 minutes) for `windows.aggregateRetentionMs` (24 hours).
Statistics are computed over 5 min / 30 min / 2 h / 6 h windows. Memory is bounded by
construction: the store does not grow with uptime.

### 4. Trend analysis with a polarity

A leak is not a value, it is a slope. `TrendAnalyzer` reports a slope only when there are at
least `trend.minSamples` samples spread over at least `trend.minSpanMs`, and only trusts it
when R² ≥ `trend.minRSquared`. The metric registry owns polarity, so a rising GPU
temperature is worsening and a *falling* `recovery_rate` is too.

### 5. Six dimensions, one number

Each metric ramps linearly from its `warn` endpoint (0 points) to its `critical` endpoint
(100 points); the registry's polarity decides which end is which. A dimension's score blends
its weighted mean with its **worst** member at `WORST_WEIGHT = 0.5`, so one critical metric
is not averaged away by five calm ones. The six dimension scores are combined with the
configured weights.

### 6. Missing telemetry is `unknown`, and coverage says so

A dimension with no known metric scores `null` and is listed in `unknownDimensions`. Its
nominal weight is **renormalized** over the dimensions that do have data, and the
renormalized share that was actually backed by telemetry is published as `coverage`. A
pressure reading at 40 % coverage can never be mistaken for a full-confidence one, and every
decision record carries `coverage_NNpct` in its reason list.

### 7. Anti-flapping is not optional

Four independent mechanisms keep the plugin from becoming a source of churn:

| Mechanism | Default | What it stops |
| --- | --- | --- |
| Sustain gate | per metric, e.g. 60 s for `gpu_temp_c` | A 30-second spike scoring at all. |
| Hysteresis | e.g. throttle enters at 55, exits at 45 | `55 -> throttle, 54 -> normal, 56 -> throttle`. |
| Debounce | 2 consecutive evaluations | A single evaluation escalating to a high-risk level. |
| Dwell | 120 s | Any transition below restart level faster than the dwell time. |
| `minRepeatActionMs` | 10 min | Re-issuing the same action sooner than allowed. |
| Three cooldowns | 5 / 30 / 60 min | Decision storms, including from a *failing* adapter. |

The cooldown starts when an adapter is actually invoked — including when it refuses or
throws. `tests/scenarios.test.js` drives a permanently critical machine for 30 minutes at a
15-second tick with a throwing restart adapter and asserts that at most three attempts reach
the adapter instead of one per tick.

### 8. Policy, then adapters

The policy engine emits at most one action per tick and never touches a process. Levels 1
and 2 go to `WorkerControlAdapter`; levels 3 and 4 become a `RestartRequest` for
`RestartAdapter`. Every applied action produces exactly one audit record with its pressure,
coverage, named drivers, reason codes and the adapter's answer.

## Model-facing tools

Three tools are registered when the profile has a tool runtime. All three are read-only: none
of them exercises a capability.

### `health_status`

Reports the current health of the DS-Hns runtime. Parameters: `section`
(`full` | `pressure` | `maintenance` | `providers`, optional, defaults to `full`).

```text
health_status({ "section": "pressure" })

Restart Pressure: 21 / 100
State: THROTTLED
Coverage: 60%
Primary cause: gpu_usage=95.00 pp scores 89/100, held 1260s
  [0.3] gpu_usage_critical: gpu_usage=95.00 pp scores 89/100, held 1260s
  [0.2] cpu_usage_critical: cpu_usage=90.00 pp scores 71/100, held 1260s
  [0.2] gpu_temp_c_critical: gpu_temp_c=88.00 °C scores 71/100, held 1260s
```

The `full` section is the whole report: pressure, state, primary cause, coverage, unknown
dimensions, maintenance summary, safe-point summary, capability states, a per-dimension
table, drivers, worsening trends, provider status, memory lines, the last five decisions and
the tick's warnings. The `maintenance` and `providers` sections are single-topic views of the
same snapshot.

### `health_history`

Returns rolling-window statistics for one canonical metric.

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `metric` | string | yes | A canonical metric name, e.g. `gpu_temp_c`. |
| `window_minutes` | number | no | Restrict output to windows at or below this size. |

An unknown metric name throws with the full canonical list in the message.

```json
{
  "metric": "process_rss_bytes",
  "windows": [
    {
      "window_minutes": 30,
      "count": 120,
      "mean": 2540000000,
      "p95": 2870000000,
      "max": 2900000000,
      "latest": 2880000000,
      "slope_per_hour": 1200000000,
      "r_squared": 0.9821,
      "consecutive_ms": 0,
      "span_ms": 1785000
    }
  ]
}
```

### `health_policy`

Explains the decision policy. Parameters: `action` (`explain` | `config` | `decisions`,
optional, defaults to `explain`).

```text
health_policy({ "action": "explain" })

Action ladder (enter/exit pressure):
  1 THROTTLE              enter >= 55, exit <= 45
  2 PAUSE_NEW_WORK        enter >= 70, exit <= 60
  3 REQUEST_APP_RESTART   enter >= 80, exit <= 68
  4 REQUEST_SYSTEM_REBOOT enter >= 95, exit <= 85

Levels 1 and 2 are applied by this plugin through the worker-control adapter.
Levels 3 and 4 are *requests* handed to dsh-restart, which owns restart execution.
A restart request is additionally gated by the maintenance window and by getMaintenanceReadiness().

Dimension weights: time=0.15, thermal=0.2, memory=0.25, runtime=0.15, worker=0.15, computer_use_ui=0.1
Weights are renormalized over the dimensions that actually have telemetry; the fraction that does is reported as coverage.
```

`config` returns the resolved numbers as JSON (`preset`, `thresholds`, `weights`,
`cooldowns`, `anti_flap`, `maintenance`, `windows_ms`, `sampling`). `decisions` returns the
last 20 audit records as JSON.

## Configuration

Configuration is a partial document. It is deep-merged onto the selected preset, so every
leaf you omit comes from the preset; arrays replace rather than merge. The plugin registers
the settings namespace **`health-scheduler`** when the profile provides a settings service,
and runs from the bundle patch alone when it does not.

The complete key-by-key reference, including the stats-file format and the command-probe
format, is in **[docs/configuration.md](docs/configuration.md)**.

| Group | Keys | Default |
| --- | --- | --- |
| Master | `enabled`, `preset` | `true`, `balanced` |
| `sampling` | `intervalMs`, `trendIntervalMs`, `persistIntervalMs`, `providerBackoffMs`, `providerBackoffMaxMs` | 15 s, 60 s, 300 s, 30 s, 600 s |
| `windows` | `rawMs`, `windowsMs`, `aggregateBucketMs`, `aggregateRetentionMs`, `dailyRetentionMs` | 30 min, `[5m,30m,2h,6h]`, 5 min, 24 h, 14 d |
| `trend` | `minSamples`, `minSpanMs`, `minRSquared` | 3, 5 min, 0.5 |
| `weights` | `time`, `thermal`, `memory`, `runtime`, `worker`, `computer_use_ui` | 0.15 / 0.20 / 0.25 / 0.15 / 0.15 / 0.10 |
| `thresholds` | one `{enter, exit}` band per action | 55/45, 70/60, 80/68, 95/85 |
| `metrics` | per canonical metric: `band`, `weight`, `sustainMs`, `trendPointsPerHour`, `trendCap` | see [docs/metrics.md](docs/metrics.md) |
| `cooldowns` | `throttleMs`, `maintenanceMs`, `escalationMs` | 5 min, 30 min, 60 min |
| `throttle` | `concurrencyLimit`, `concurrencyFactor` | `null`, `0.5` |
| `maintenance` | `enabled`, `targetTime`, `windowStart`, `windowEnd`, `maxDeferMs`, `urgentOverridePressure`, `allowAppRestart`, `safePointRequired` | `false`, `04:00`, `03:30`, `05:00`, 60 min, 92, `true`, `true` |
| `antiFlap` | `minStateDwellMs`, `minRepeatActionMs`, `debounceEvaluations` | 120 s, 10 min, 2 |
| `resilience` | `providerFailureLimit`, `providerRetryAfterBackoff`, `reportDegradedCapability` | 3, `true`, `true` |
| `storage` | `enabled`, `directory`, `maxLogBytes`, `maxRecentDecisions` | `true`, `null`, 4 MiB, 50 |
| Providers | `disabledProviders`, `providerOptions` | `[]`, see docs |

A configuration that cannot be acted on is rejected loudly. `resolveConfig` throws a
`ConfigError` naming the dotted path; the plugin's `apply` catches it, logs it and continues
on the `balanced` preset rather than failing the boot.

## Presets

All three presets start from the same neutral `balanced` document and differ in exactly four
places. `PRESET_SCALES` in `src/core/presets.ts` is the whole story:

```ts
conservative: { enter: 0.85, exit: 0.75, cooldown: 1.5, maintenance: 0.85 }
balanced:     { enter: 1,    exit: 1,    cooldown: 1,   maintenance: 1 }
aggressive:   { enter: 1.15, exit: 1.05, cooldown: 0.7, maintenance: 1.3 }
```

`scalePreset` multiplies every ladder `enter` **and** `exit` by `enter` (the `exit` field of
the scale object is declared but the code scales both endpoints by the same factor, so
hysteresis stays proportional), the three cooldowns by `cooldown`, and
`maxDeferMs` / `minStateDwellMs` / `minRepeatActionMs` by `maintenance`.
`urgentOverridePressure` is *divided* by the band factor, so a lower-pressure machine treats
pressure as urgent sooner.

| Field | conservative | balanced | aggressive |
| --- | --- | --- | --- |
| `thresholds.throttle` enter / exit | 47 / 38 | 55 / 45 | 63 / 52 |
| `thresholds.pause_new_work` enter / exit | 60 / 51 | 70 / 60 | 81 / 69 |
| `thresholds.request_app_restart` enter / exit | 68 / 58 | 80 / 68 | 92 / 78 |
| `thresholds.request_system_reboot` enter / exit | 81 / 72 | 95 / 85 | 99 / 98 |
| `cooldowns.throttleMs` | 7.5 min | 5 min | 3.5 min |
| `cooldowns.maintenanceMs` | 45 min | 30 min | 21 min |
| `cooldowns.escalationMs` | 90 min | 60 min | 42 min |
| `maintenance.maxDeferMs` | 51 min | 60 min | 78 min |
| `maintenance.urgentOverridePressure` | 108 | 92 | 80 |
| `antiFlap.minStateDwellMs` | 102 s | 120 s | 156 s |
| `antiFlap.minRepeatActionMs` | 8.5 min | 10 min | 13 min |

Note that a preset preserves the *relative* width of every hysteresis band rather than
flattening it, and entries are capped at 99 so no rung can be scaled out of reach: a
pressure above 100 does not exist, so an entry of 109 would silently delete that rung. On
`aggressive` the `REQUEST_SYSTEM_REBOOT` rung needs a perfectly saturated model
(entry 99, exit 98), which is exactly the "only under real duress" behaviour that preset is
meant to have. The metric table itself — every band, `sustainMs` and trend point — is
identical in all three presets.

The three presets are also shipped as JSON under [`presets/`](presets/) for diffing, together
with a JSON Schema for a whole configuration document.

## Capabilities and degradation

The plugin degrades; it does not fail. Each of these is a normal, well-typed outcome.

| Situation | What happens |
| --- | --- |
| `dsh-restart` is not installed | `UnavailableRestartAdapter` reports `capability: 'unavailable'`. Monitoring and throttling continue. A restart decision is downgraded to `PAUSE_NEW_WORK` with reason `restart_capability_unavailable`. |
| No worker-control service is bound | `UnavailableWorkerControlAdapter` reports `unavailable`. A `THROTTLE` attempt returns `applied: false` with a detail explaining it; the tick continues. |
| A provider throws | That provider only is disabled for an exponential backoff (`providerBackoffMs * 2^steps`, capped at `providerBackoffMaxMs`, starting once consecutive failures reach `providerFailureLimit`). Its metrics simply stop arriving and become `unknown`. |
| A provider returns `degraded: true` | The metrics it *did* measure stay authoritative; the note is surfaced in the snapshot's `warnings`. |
| A sensor does not exist | The metric key is omitted. The dimension may become `unknown`, coverage drops, and the reason list says so. |
| No stats file exists yet / it is stale | Nothing is reported and a detail names the paths that were looked for; a stale file's contents are refused and the sample is degraded with the staleness detail. |
| A configured helper command fails or times out | The probe error is reported as a degraded sample; already-measured metrics are kept. |
| The decision log is not writable | `DecisionLog` counts the failure and exposes it via `lastError`; the scheduler keeps ticking. |
| No safe-point source is registered | `foldReadiness` returns `safe: null`. With `safePointRequired: true` a restart request is blocked with reason `safe_point_unknown` — an unanswered question is not a `yes`. A source that throws or hangs contributes an `unknown` reading after a 1-second per-source budget. |
| The settings service or tool runtime is absent | A warning is logged and the plugin runs from the bundle patch alone, or registers no tools. A `ConfigError` from a bad user document is logged and the `balanced` preset is used instead of failing the boot. |

## Provider telemetry matrix

Seven provider ids are registered by default. **Be careful with this table**: most of the
designed metrics have no native source, and the plugin says so instead of guessing.

| Provider id | Measured natively | Needs an external seam | Notes |
| --- | --- | --- | --- |
| `hardware` | `cpu_usage` | `cpu_temp_c`, `gpu_temp_c`, `gpu_usage`, `thermal_throttle`, `power_limit_hit` | `cpu_usage` is a real delta of `os.cpus()` time counters and needs no privilege. `gpu_usage` is **not** native — there is no GPU counter here. All five thermal metrics arrive through `providerOptions.hardware.helperCommand` or a stats file. |
| `memory` | `ram_total_bytes`, `ram_available_bytes`, `ram_used_ratio`, `process_rss_bytes` | `commit_used_ratio`, `process_private_bytes`, `vram_used_ratio` | From `os.totalmem()`, `os.freemem()` and the process RSS. `process_rss_bytes` is the *process tree* only when a platform helper supplied `treeRssBytes`; otherwise it is this process's RSS. |
| `runtime` | `uptime_seconds`; `handle_count` when the runtime exposes `process.getActiveResourcesInfo()` | `event_loop_latency_ms`, `worker_process_count`, `thread_count`, `restart_count`, `ipc_timeout_rate`; `heartbeat_delay_ms` from a heartbeat file | The five middle metrics come from an injected `RuntimeFeed`. The plugin's own entry point passes `EMPTY_RUNTIME_FEED`, which answers `null` to everything — so with no integration they are **always unknown**. `handle_count` counts libuv handles plus timeouts, not OS handles. |
| `workers` | nothing | `active_workers`, `queued_tasks`, `task_latency_ms`, `timeout_rate`, `retry_rate`, `failure_rate`, `spawn_failure_rate`, `abnormal_exit_rate`, `queue_delay_ms` | Stats file or `providerOptions.statsFile.commands`. The plugin does not instrument worker internals. |
| `computer-use` | nothing | `screenshot_latency_ms`, `action_latency_ms`, `verification_retry_rate`, `missed_target_rate`, `recovery_rate`, `desktop_responsiveness_ms` | Stats file or command probe. `providerOptions.computerUse` is declared but not wired to any probe yet. |
| `ui` | nothing | `render_latency_ms`, `main_window_heartbeat_ms`, `blank_frame_rate`, `frontend_error_rate` | Stats file or command probe, written by the web client's telemetry. |
| `context` | nothing | `task_failure_rate`, `git_operations_per_minute` | Stats file or command probe. |

Two consequences worth stating plainly: on a default install with no helper, no stats file and
no integration, only `cpu_usage`, the three RAM ratios and `uptime_seconds` have values, and
the report says the coverage is low. And **CPU/GPU temperature is not measured natively** —
there is no NVML, no WMI and no LibreHardwareMonitor binding inside this plugin. See
[docs/configuration.md](docs/configuration.md#reading-a-gpu-temperature-on-windows) for a
working PowerShell helper.

## Not implemented yet / Roadmap

Everything below is honestly absent from `0.1.0` rather than partially working.

- **`cordis.patch.yml` is missing from the repository.** `package.json` declares
  `dsh.bundle.patch: ./cordis.patch.yml` and lists the file in `files`, but the file itself is
  not checked in. Until it exists, `dsh plugin add` installs the package as a plain dependency
  and warns that it declares no usable bundle, so the plugin never joins the profile layer
  stack. The registerable rows themselves (`name`, `inject`, `apply`, the `health-scheduler`
  settings namespace, the three tools) are all implemented.
- **`scripts/verify-artifacts.mjs` does not exist**, so `npm run verify:artifacts` fails.
- **`npm run presets` does not exist.** `scripts/generate-presets.mjs` works
  (`node scripts/generate-presets.mjs`, or `--check`), and the four generated files are
  currently up to date, but the npm alias documented in `presets/README.md` was never added to
  `package.json`.
- **The `./startup` subpath export points at files that are not built.** `package.json` exports
  `./startup` as `./lib/startup.js`; there is no `src/startup.ts`, so that subpath cannot
  resolve. Nothing in the package imports it.
- **No UI page.** The design's Health page is not implemented. All of its data is present in
  `metricsSnapshot()` / `HealthSnapshot`, but no client plugin renders it.
- **No daily summary rollup and no long-horizon trend read.** `windows.dailyRetentionMs` is
  validated and never read, and `TrendAnalyzer` fits raw points only, so a horizon longer than
  `windows.rawMs` returns no samples. The 24 hours of aggregates are retained but unused.
- **Four configuration keys are accepted and ignored**: `sampling.persistIntervalMs`,
  `resilience.reportDegradedCapability`, `providerOptions.computerUse.probeOnTick` and
  `providerOptions.computerUse.probeTimeoutMs`. They validate, they appear in the resolved
  config and in `health_policy config`, and they change nothing.
- **`providerOptions.memory.extraPids` is a note, not an implementation.** It is counted into a
  sample note but does not add any process to the RSS sum.
- **The Long-Run test tier is not implemented.** The design asks for 6 h / 12 h synthetic and a
  24 h real-machine soak; the repository has unit and synthetic-scenario tests only.

## Documentation index

| Document | English | 中文 |
| --- | --- | --- |
| Canonical metric registry: unit, polarity, bounds, default band, sustain, provider | [docs/metrics.md](docs/metrics.md) | [docs/metrics.zh.md](docs/metrics.zh.md) |
| The pressure model: dimensions, ramps, `WORST_WEIGHT`, trend, coverage, worked examples | [docs/pressure-model.md](docs/pressure-model.md) | [docs/pressure-model.zh.md](docs/pressure-model.zh.md) |
| The action ladder, anti-flapping, cooldowns, dispatch, safe points, maintenance phases | [docs/policies.md](docs/policies.md) | [docs/policies.zh.md](docs/policies.zh.md) |
| Every configuration key, the stats-file format, the command-probe format | [docs/configuration.md](docs/configuration.md) | [docs/configuration.zh.md](docs/configuration.zh.md) |
| Acceptance criteria and design scenarios mapped to named tests | [docs/acceptance.md](docs/acceptance.md) | [docs/acceptance.zh.md](docs/acceptance.zh.md) |
| Preset documents and the generated JSON Schema | [presets/README.md](presets/README.md) | — |
| Release history | [CHANGELOG.md](CHANGELOG.md) | — |
| How to contribute and the engine's honesty rules | [CONTRIBUTING.md](CONTRIBUTING.md) | — |
| Threat model and responsible disclosure | [SECURITY.md](SECURITY.md) | — |

## Development

```sh
npm install            # dev dependencies only; the plugin has no runtime dependencies
npm run build          # tsc -p tsconfig.json -> lib/
npm test               # npm run build && node --test tests/*.test.js
npm run test:only      # node --test tests/*.test.js, against the existing lib/
npm run typecheck      # tsc -p tsconfig.json --noEmit
npm run verify:artifacts   # broken: script not yet written (see Roadmap)
```

TypeScript settings worth knowing: `strict`, `noUncheckedIndexedAccess`,
`noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `target: ES2023`,
`module: NodeNext`. The engine (`src/core`, `src/types`, `src/providers`, `src/adapters`,
`src/audit`) has **no dependency on the harness**; only `src/dsh/` knows about Cordis, and it
does so through the narrow structural interfaces in `src/dsh/context.ts`. That is what makes
the whole engine testable without a runtime. The suite is 87 tests across 6 files and passes as
committed:

```sh
node --test tests/*.test.js
# tests 87 / suites 16 / pass 87 / fail 0
```

## FAQ

**Does it restart my machine?**
No. It cannot. There is no restart execution in this plugin at all — no `taskkill`, no
`reboot`, no process kill. Levels 3 and 4 produce a `RestartRequest` object and hand it to
whatever `RestartAdapter` is on the context. With no `dsh-restart` installed that adapter
reports `unavailable` and the request is downgraded to `PAUSE_NEW_WORK`.

**What if a temperature sensor is missing?**
The metric is simply absent from the sample. `cpu_temp_c` and `gpu_temp_c` are never measured
natively, so on a default install they are always absent unless you configure a helper command
or a stats file. The thermal dimension then scores only what it does have (`cpu_usage`, and
anything the helper supplies); if it has nothing at all it is `unknown`, coverage drops, and
the report prints it under `Unknown dimensions: … (not scored as healthy)`. It is never
scored as `0`.

**Why is my pressure 0 but state `DEGRADED`?**
Because they answer different questions. `restart_pressure` can be 0 while pressure sits above
the throttle *exit* band — the state machine calls that `DEGRADED`, not `HEALTHY`. And
`pressure: null` (nothing measurable at all) also yields `DEGRADED`, on purpose: unknown is
not health. The reason list on the decision record names the gate that held.

**How do I disable it?**
Three ways, in increasing bluntness. Set `enabled: false` in the plugin configuration — it
still loads, registers its namespace and its tools, but collects nothing and starts no loop.
Or disable individual providers with `disabledProviders: ["hardware"]`. Or remove it from the
profile with `dsh plugin --profile web remove dsh-health-scheduler`, which also drops it from
the profile's bundle list. Uninstalling does not affect DS-Hns.

**How much disk does it use?**
Almost none, and it is bounded. The decision log is one `decisions.jsonl` under
`<DSH_HOME>/health-scheduler` (or `storage.directory`), rotated by rename once it exceeds
`storage.maxLogBytes` — 4 MiB by default, so the worst case is roughly 8 MiB with one `.bak`
beside it. Nothing else is written: the rolling history is in memory, bounded by
`windows.rawMs` and `windows.aggregateRetentionMs`. `storage.enabled: false` makes the plugin
strictly memory-only.

**How do I add a custom sensor?**
Write it into a stats file, or expose it as a command probe. Both speak the canonical metric
vocabulary, and non-canonical keys are reported rather than silently dropped. If your sensor
is genuinely new, the canonical registry must be extended — a provider can only report names
that exist in `src/types/metrics.ts`. See
[docs/configuration.md](docs/configuration.md#adding-a-custom-sensor).

**Will it fight with `dsh-restart`?**
It cannot fight, because it cannot act. It posts a `RestartRequest` with a caller-chosen
`requestId` and reads back `accepted` / `rejected` plus the restart side's lifecycle state.
Locks, rate limits, checkpoint tokens and crash-loop breaking all belong to `dsh-restart`;
this plugin's cooldowns pace only *its* requests, and a rejection starts the cooldown instead
of retrying immediately. Uninstalling `dsh-restart` leaves monitoring and throttling fully
functional.

**Does it need admin rights?**
No. It reads `os.cpus()`, `os.totalmem()`, `os.freemem()`, `process.memoryUsage()`,
`process.uptime()` and (when available) `process.getActiveResourcesInfo()`, reads and stats
files, and optionally runs the helper command you configure. A helper pointed at something
privileged inherits *your* privileges — that is your choice, not a requirement of the plugin,
which never escalates on its own.

**Why is coverage only 60 %?**
Because only four of the six dimensions have telemetry. Coverage is the share of nominal
weight backed by actual measurements. With no integration, `runtime` metrics other than
uptime, all `worker` metrics and all `computer_use_ui` metrics have no source, so coverage
sits near 0.6 when hardware and memory are reporting. That is the feature working: a
60 %-coverage pressure is labelled as such instead of pretending to be a full-confidence one.

**Does it slow my machine down?**
It ticks every 15 seconds by default and each tick is cheap: a few `os` calls, one stats-file
read at most once per 2 seconds, and at most one helper run per configured probe. Rolling
memory is bounded by construction, so nothing grows with uptime. The heaviest thing it can do is
the helper command *you* configure, which runs under a timeout you set (`helperTimeoutMs`, 5 s).

## License

MIT © 2026 dsh-health-scheduler contributors. See [LICENSE](LICENSE).

This is a **community plugin**. It is not affiliated with, sponsored by, or endorsed by
DeepSeek. "DeepSeek Harness" and "DS-Hns" are used descriptively to say what the plugin
integrates with.

Installing a plugin means running third-party code **with your privileges** — this one
included. Read [SECURITY.md](SECURITY.md) before you install it into a profile that can
reach production credentials or an unattended machine.
