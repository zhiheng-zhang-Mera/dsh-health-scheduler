# Configuration reference

[English](configuration.md) | [中文](configuration.zh.md)

Configuration is a **partial document**. It is deep-merged onto the preset named by `preset`
(absent → `balanced`), so every leaf you omit comes from the preset. Two merge rules matter:

- **Objects merge deeply.** Writing `{ "maintenance": { "enabled": true } }` changes one leaf
  and leaves `targetTime`, `windowStart`, and the rest of `maintenance` at their preset values.
- **Arrays replace.** `windowsMs`, `disabledProviders`, `ignoreMetrics`, `extraPids`,
  `statsFile.paths` and `statsFile.commands` are taken verbatim; they are never appended to.
- **`null` is a value, not a delete.** `storage.directory: null` means "use the default
  directory". The keys that accept `null` are exactly `throttle.concurrencyLimit`,
  `maintenance.urgentOverridePressure`, `storage.directory`,
  `providerOptions.hardware.helperCommand`, `providerOptions.runtime.heartbeatFile` and
  `providerOptions.statsFile.paths` (as an empty array).

## Where the document goes

Three places, in increasing precedence:

1. **The bundle patch row** — the `config:` block of the plugin's row in
   [`cordis.patch.yml`](../cordis.patch.yml). **A patch replaces the targeted row's whole
   `config`; it does not deep-merge keys.** An override that restates only part of a nested
   object loses the rest, so copy the whole nested object you want to change.
2. **The `health-scheduler` settings namespace** — registered when the profile provides a
   settings service. `scope.watch` calls `resolveConfig` on every change and calls
   `scheduler.reconfigure`, so settings changes apply **live**: history, the policy state and the
   daily rollup are preserved and provider backoff windows are reset.
3. **Direct library use** — `resolveConfig(overrides)` / `createScheduler({ config, … })`.

The merge described in the rest of this document applies to the document the plugin receives
(steps 2 and 3, and whatever the row's `config` ends up being). `deepMerge` merges objects
deeply, replaces arrays, and treats `null` as a value rather than a delete.

One casing trap to be aware of: `resolveConfig` reads `trend.minRSquared` with a capital `S`,
while the shipped `cordis.patch.yml` spells it `minRsquared`. An unrecognised leaf is simply
ignored rather than rejected, so the patch behaves correctly (the default `0.5` applies) but that
particular line does nothing. Use the exact spelling from the table below.

A document that cannot be acted on is rejected loudly. `resolveConfig` throws a `ConfigError`
whose message is `health-scheduler config: <dotted.path> <explanation>`. The plugin's `apply`
uses `tryResolveConfig`, which logs the error and falls back to `resolveConfig({ preset:
'balanced' })` rather than failing the boot.

A whole-document JSON Schema is generated at
[`presets/schema.json`](../presets/schema.json) (draft 2020-12) and mirrors the checks
`resolveConfig` performs.

## Master switches

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch. When `false` the plugin still loads, registers its settings namespace and its tools, but `HealthScheduler.start()` returns immediately, `tick()` short-circuits before sampling, and nothing is collected or applied. Snapshot `pressure` stays `null`. |
| `preset` | `'conservative'` \| `'balanced'` \| `'aggressive'` \| `'custom'` | `'balanced'` | Selects the base document. Explicit values elsewhere always win over the preset. An unrecognised name falls back to `balanced` at runtime (`preset()`), which is why the schema's enum excludes anything else. `'custom'` is accepted as a *label only* — it is not a preset and resolves to `balanced`. |

## `sampling`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `intervalMs` | number > 0 | `15000` (15 s) | Milliseconds between scheduler ticks. The timer is `unref()`ed, so it never keeps the process alive on its own. |
| `trendIntervalMs` | number > 0 | `60000` (60 s) | How often the full trend sweep runs. Between sweeps the snapshot reuses the previous trend list, so a 15 s tick does not refit every metric 4×/min. |
| `summaryIntervalMs` | number > 0 | `300000` (5 min) | How often the per-day summary is re-folded for a snapshot. The fold reads aggregate buckets, not raw samples, so this is a memoisation window rather than a retention setting. |
| `providerBackoffMs` | number ≥ 0 | `30000` (30 s) | Base of the provider circuit-breaker backoff. `0` disables the delay (the failure counter still increments). |
| `providerBackoffMaxMs` | number > 0 | `600000` (10 min) | Ceiling of the exponential backoff. |

The backoff schedule is
`providerBackoffMs * 2^min(consecutiveFailures - providerFailureLimit, 8)`, capped at
`providerBackoffMaxMs`, and it is `0` while consecutive failures are still below
`providerFailureLimit`. With the defaults: three failures are tolerated freely, then 30 s, 60 s,
120 s, … up to 10 minutes.

## `windows`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `rawMs` | number > 0 | `1800000` (30 min) | **Minimum** raw retention. The effective value is `max(rawMs, longest windowsMs entry)`, so a 6-hour statistics window is always fully backed by samples. |
| `windowsMs` | non-empty, strictly ascending array of numbers > 0 | `[300000, 1800000, 7200000, 21600000]` (5 min, 30 min, 2 h, 6 h) | Windows for which `WindowStats` are computed and which `health_history` reports. |
| `aggregateBucketMs` | number > 0 | `300000` (5 min) | Bucket size for the long-horizon mean/max/min series. |
| `aggregateRetentionMs` | number > 0 | `86400000` (24 h) | How long buckets are kept. |
| `dailyRetentionMs` | number > 0 | `1209600000` (14 days) | Horizon for the per-day rollup. Buckets older than this are excluded from `dailySummaries()`, so this is what bounds the "was last Tuesday worse than today?" answer. |

Memory is bounded by construction: raw points are pruned to `rawMs` on every write and buckets
to `aggregateRetentionMs`, so the store does not grow with uptime.

### Daily summaries

`RollingStore.dailySummaries(nowMs)` folds the retained aggregate buckets into one summary per
**local calendar day**, per metric:

```ts
interface DailySummary {
  dayStart: string                     // ISO-8601 of local midnight
  metrics: readonly {
    metric: CanonicalMetric
    count: number                      // total samples behind the day
    mean: number                       // weighted by sample count, not a mean of means
    max: number
    min: number
  }[]
}
```

Three properties are worth knowing:

- **Means combine by sample count**, so a quiet hour cannot outvote a busy one.
- **Cost is proportional to the number of buckets, not to uptime.** Nothing is recomputed from
  raw samples; there are no raw samples that old.
- **Days are local calendar days**, so a day is comparable across a DST change; a 23- or
  25-hour day is still one day.

The result is published on every `HealthSnapshot` as `dailySummaries()` and in the JSON payload
as `daily_summaries`. It is the only long-horizon answer the plugin offers today: there is no
*trend* fit over the aggregate series, because `TrendAnalyzer` reads raw points only.

> **The trend horizon is the longest `windowsMs` entry.** `PressureEngine` and the scheduler
> both pass `windowsMs[windowsMs.length - 1]` as the trend look-back, and `TrendAnalyzer` fits
> **raw** points only. A horizon longer than `rawMs` therefore fits fewer points than the
> horizon suggests. With the defaults, `rawMs` is raised to 6 h to match, so this is consistent
> — but if you set `windowsMs: [5m, 24h]` the horizon becomes 24 h and the effective retention
> becomes 24 h too, which is a large amount of raw history for a 15-second tick
> (5 760 points per metric).

## `trend`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `minSamples` | number > 0 | `3` | Minimum samples in the horizon before a slope is reported. Truncated to an integer and raised to at least `2`. |
| `minSpanMs` | number ≥ 0 | `300000` (5 min) | Minimum observation span before a slope is reported. |
| `minRSquared` | finite number | `0.5` | Minimum R² for a slope to be trusted. Below it, `direction` is `'flat'` and `isWorsening` is `false`. Not range-checked: a value above 1 makes every trend untrusted. |

## `weights`

| Key | Type | Default |
| --- | --- | --- |
| `time` | number ≥ 0 | `0.15` |
| `thermal` | number ≥ 0 | `0.2` |
| `memory` | number ≥ 0 | `0.25` |
| `runtime` | number ≥ 0 | `0.15` |
| `worker` | number ≥ 0 | `0.15` |
| `computer_use_ui` | number ≥ 0 | `0.1` |

Every value must be a finite number ≥ 0 and the six together must have a positive total. The
total does **not** have to be 1: weights are renormalized over the dimensions that have
telemetry, and again within each dimension over the metrics that have a score. See
[pressure-model.md](pressure-model.md#unknown-handling-and-coverage-renormalization).

## `thresholds`

Four hysteresis bands. Each is `{ enter: number, exit: number }` with a **required**
`exit < enter`.

| Key | Default `enter` / `exit` | Effect |
| --- | --- | --- |
| `throttle` | `55` / `45` | Pressure at or above `enter` selects `THROTTLE`; the action is held until pressure drops to `exit` or below. Also the boundary between `HEALTHY` and `DEGRADED`. |
| `pause_new_work` | `70` / `60` | Same, for `PAUSE_NEW_WORK`. |
| `request_app_restart` | `80` / `68` | Same, for `REQUEST_APP_RESTART`. Also the level below which dwell applies. |
| `request_system_reboot` | `95` / `85` | Same, for `REQUEST_SYSTEM_REBOOT`. |

Additional cross-field rules enforced by `requireThresholds`, in ladder order
(`throttle → pause_new_work → request_app_restart → request_system_reboot`):

- `enter` must be **strictly** greater than the previous rung's `enter`.
- `exit` must **not** be lower than the previous rung's `exit`.

## `metrics`

An object keyed by canonical metric name. An unknown key is rejected with the full canonical
list in the message. Each value is:

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `band` | `{ warn: number, critical: number }` | preset value | Ramp endpoints. `warn` must differ from `critical`. Either order is accepted; the registry's polarity decides which end is bad. **Omitting `band` removes the metric's level score entirely** — it then contributes only through its trend term (or not at all). |
| `weight` | number ≥ 0 | `1` | Weight of this metric inside its dimension. |
| `sustainMs` | number ≥ 0 | per metric, see [metrics.md](metrics.md) | Milliseconds the metric must hold its band before its score counts. `0` disables the gate. |
| `trendPointsPerHour` | number ≥ 0 | `0` | Points added per hour of trusted worsening slope, before the reference-slope normalization. `0` disables the trend term. |
| `trendCap` | number ≥ 0 | `25` | Ceiling on the trend contribution. |

The default table, every band, and which provider supplies each metric, are in
[metrics.md](metrics.md). Worked ramp and trend values are in
[pressure-model.md](pressure-model.md).

A metric that is **absent from `metrics` entirely** is not evaluated at all: it is collected,
stored, trended if you added it via a provider, and rendered — it simply has no opinion about
pressure. The balanced preset deliberately omits `ram_total_bytes` and `worker_process_count`.

## `cooldowns`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `throttleMs` | number ≥ 0 | `300000` (5 min) | Cooldown bucket for `THROTTLE` and `PAUSE_NEW_WORK`. |
| `maintenanceMs` | number ≥ 0 | `1800000` (30 min) | Cooldown bucket for `REQUEST_APP_RESTART`. |
| `escalationMs` | number ≥ 0 | `3600000` (60 min) | Cooldown bucket for `REQUEST_SYSTEM_REBOOT`. |

Each cooldown starts when the adapter is **actually invoked**, including when it refuses or
throws. See [policies.md](policies.md#the-cooldown-starts-on-the-attempt-not-the-decision).

## `throttle`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `concurrencyLimit` | positive integer \| `null` | `null` | Explicit concurrency the `THROTTLE` action asks for. When `null`, a limit is derived from the observed `active_workers`. Fractions are truncated and anything below 1 is raised to 1. |
| `concurrencyFactor` | number > 0 | `0.5` | Multiplier applied to `active_workers` when `concurrencyLimit` is `null`. Clamped into `0.05 … 1`. |

The derivation, and the deliberate refusal to guess:

```ts
function throttleLimit(config, activeWorkers) {
  if (config.throttle.concurrencyLimit !== null) return config.throttle.concurrencyLimit
  if (activeWorkers === null || activeWorkers <= 0) return null
  return Math.max(1, Math.floor(activeWorkers * config.throttle.concurrencyFactor))
}
```

| `active_workers` | Derived limit (factor 0.5) |
| --- | --- |
| `null` (unknown) | `null` → throttle is a no-op with an explanatory detail |
| `0` | `null` → same |
| `1` | `1` |
| `3` | `1` |
| `8` | `4` |
| `16` | `8` |

A `null` limit produces `applied: false` with detail
`"no concurrency target configured or derivable; throttle is a no-op"`. Asking a harness to
reduce an unknown quantity is how a health plugin accidentally stops all work, so it refuses.

## `maintenance`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Whether scheduled maintenance is armed. When `false`, the phase is always `outside_window`, `nextTargetAt` is `null`, and `maintenanceAllowsRequest` returns `false`. |
| `targetTime` | `"HH:MM"` 24-hour | `'04:00'` | Local wall-clock target inside the window. |
| `windowStart` | `"HH:MM"` | `'03:30'` | Local start of the allowed window. |
| `windowEnd` | `"HH:MM"` | `'05:00'` | Local end of the allowed window. A value ≤ `windowStart` makes the window wrap past midnight. |
| `maxDeferMs` | number ≥ 0 | `3600000` (60 min) | Budget for deferring past the target. Once exhausted the phase becomes `overdue`, which still **allows** a request. |
| `urgentOverridePressure` | finite number \| `null` | `92` | Pressure at or above which the window is ignored. `null` disables the override. |
| `allowAppRestart` | boolean | `true` | Whether a maintenance request may be raised at all. Checked by `maintenanceAllowsRequest`; **not** checked by the policy engine's `gateRestart`, which relies on `enabled` and the window instead. Setting it `false` therefore blocks the library helper but not the policy path. |
| `safePointRequired` | boolean | `true` | When `true`, a restart request additionally requires `readiness.safe === true`. When `false`, the registry is not queried at all and readiness is `{safe: null, reason: 'safe_point_not_required'}`. |

The six phases and the exact conditions are in
[policies.md](policies.md#the-maintenance-window-state-machine).

## `antiFlap`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `minStateDwellMs` | number ≥ 0 | `120000` (2 min) | Minimum time in a state before a transition **below** restart level is allowed. Never delays the first crossing out of `NO_ACTION`. |
| `minRepeatActionMs` | number ≥ 0 | `600000` (10 min) | Minimum time between two identical applied actions, independent of the bucket cooldown. |
| `debounceEvaluations` | number > 0 | `2` | Consecutive evaluations a level-3-or-above condition must hold before it is actionable. `1` disables debounce. Truncated to an integer and raised to at least `1`. |

## `resilience`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `providerFailureLimit` | number > 0 | `3` | Consecutive failures before the exponential backoff starts. Truncated and raised to at least `1`. |
| `providerRetryAfterBackoff` | boolean | `true` | When `false`, a provider is never retried after its first failure: `isAvailable` returns `false` while `consecutiveFailures > 0`. |

## `storage`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Whether anything is written to disk. When `false`, the `DecisionLog` receives `directory: null` and stays memory-only. |
| `directory` | string \| `null` | `null` | Log directory. `null` means the environment's `stateDirectory`. If that is also `null` — which happens when `apply` is called without one — the log is memory-only even with `enabled: true`. |
| `maxLogBytes` | number > 0 | `4194304` (4 MiB) | Size at which `decisions.jsonl` is renamed to `decisions.jsonl.<ISO timestamp>.bak` and a fresh file is started. |
| `maxRecentDecisions` | number > 0 | `50` | In-memory ring size for the UI and for `health_policy decisions`. Truncated and raised to at least `1`. |

The log file is `decisions.jsonl` in that directory; each line is one JSON object with
`schemaVersion: 1`, `kind: 'decision'` and the full `DecisionRecord`. Writes are best-effort and
synchronous: a failure increments `DecisionLog.writeFailures` and sets `lastError` instead of
throwing. `readPersisted()` skips a half-written trailing line.

## `disabledProviders`

An array of non-empty strings naming provider ids to skip. Entries are trimmed. Default `[]`.

The ids the plugin itself registers are `hardware`, `memory`, `runtime`, `workers`,
`computer-use`, `ui` and `context`. A `disabledProviders` entry that names no registered provider
is harmless. Note that a provider filtered out by `disabledProviders` is **not registered at
all**, so it never appears in a sampling round's `skipped` array — the
`provider <id> skipped (backoff or disabled)` warning is produced only for a *registered*
provider that is inside its backoff window or individually reporting `enabled: false`.

## `providerOptions`

### `providerOptions.hardware`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `ignoreMetrics` | array of canonical metric names | `[]` | Metrics the hardware provider must drop even when the helper reports them. Invalid names are silently filtered out by `resolveConfig` (`.filter(isCanonicalMetric)`). |
| `helperCommand` | array of strings \| `null` | `null` | Command and arguments, executed **without a shell**. Its stdout is parsed as `name=value` / `name,value` lines and merged into the sample. `null` means no thermal telemetry source. |
| `helperTimeoutMs` | number > 0 | `5000` | How long the helper may run before it is abandoned. A timeout kills the child and degrades the sample. |

The helper's parsed metrics are merged into the sample **without being filtered against the
hardware provider's own metric list**, so a helper may also supply memory metrics — but
`ignoreMetrics` is applied to the helper's output, so an ignored metric is dropped from both
the native and the helper path.

### `providerOptions.memory`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `extraPids` | array of integers ≥ 0 | `[]` | Additional pids added to `process_rss_bytes`, so the leak signal covers the whole launcher tree rather than this process alone. The sum is refreshed in the background from the platform process list (`tasklist` on Windows, `ps` elsewhere) every `2 × sampling.intervalMs`; a query that fails leaves only this process in the sum and says so in the sample note. |

The memory provider has **no helper option of its own**: `applyHealthScheduler` passes
`config.providerOptions.hardware.helperCommand` and `helperTimeoutMs` into the memory provider,
so both providers run the same command and each keeps the metrics it recognises.

### `providerOptions.runtime`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `heartbeatFile` | string \| `null` | `null` | A file the host touches on every event-loop turn. The provider reads its mtime and reports `heartbeat_delay_ms = max(0, now - mtime - heartbeatExpectedMs)`. `null` disables the reading. A configured-but-unreadable file produces a note and no metric. |
| `heartbeatExpectedMs` | number > 0 | `15000` | Expected heartbeat cadence. |

A file exactly on time reports `0`; a file that stopped being touched reports its full age,
which is what makes a frozen UI visible.

### `providerOptions.computerUse`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |

### `providerOptions.statsFile`

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `paths` | array of non-empty strings | `[]` | Files to read, in order. The **first readable** one wins; a path that does not exist is skipped. Reads are cached for at most 2 seconds. |
| `staleAfterMs` | number > 0 | `120000` (2 min) | Age at which a file's contents are refused and its providers report a degraded sample with a detail naming the file's age. |
| `commands` | array of `{ argv, timeoutMs? , format }` | `[]` | Extra probes run by **all four** stats-backed providers. See below. |

The four stats-backed providers (`workers`, `computer-use`, `ui`, `context`) share **one**
`StatsFileSource` and **one** command list. Because each provider copies only the metrics in
its own `provides` list out of the shared result, a command may print metrics for several
groups at once and each provider will take what it owns. A metric that no stats-backed provider
owns — `ipc_timeout_rate`, for instance — is silently ignored even if the file or command
reports it correctly, and it will appear in the sample's `unknownKeys` note when it came from a
file.

## The stats-file format

A stats file is a JSON document. Two shapes are accepted:

```json
{
  "timestamp": "2026-03-01T04:00:00.000Z",
  "schemaVersion": 1,
  "source": "ds-hns-web-client",
  "metrics": {
    "render_latency_ms": 180,
    "main_window_heartbeat_ms": 1000,
    "blank_frame_rate": 0.01,
    "frontend_error_rate": 0.0
  }
}
```

```json
{ "render_latency_ms": 180, "screenshot_latency_ms": 640 }
```

Rules the reader enforces:

- If the document has an object-valued `metrics` key, that object is the payload; otherwise the
  document itself is.
- `timestamp`, `schemaVersion` and `source` are skipped wherever they appear.
- A key that is not a canonical metric name is collected into `unknownKeys` and surfaced in the
  sample's `note` as `stats file contains non-canonical keys: …`. It is **never** folded into
  the metrics, so a typo shows up instead of doing nothing.
- A value that is not a finite number is ignored.
- The file's mtime, not any `timestamp` field, decides staleness.
- Written atomically or not at all: a truncated JSON document fails to parse, and the reading
  falls through to the next path in `paths`. If no path parses, the detail names every path that
  was tried.

A minimal writer, run on a schedule or from the component that owns the numbers:

```powershell
# C:\dsh\telemetry\publish.ps1 — writes the stats file the UI provider reads
$payload = @{
  timestamp = (Get-Date).ToUniversalTime().ToString('o')
  metrics   = @{
    render_latency_ms        = 180
    main_window_heartbeat_ms = 1000
    blank_frame_rate         = 0.01
  }
}
$payload | ConvertTo-Json -Depth 4 | Set-Content -Path 'C:\dsh\telemetry\metrics.json' -Encoding utf8
```

## The command-probe format

A command probe is an `argv` array executed by `execFile` **without a shell**, with
`maxBuffer` 1 MiB and `windowsHide: true`. Its stdout is parsed line by line:

| Line | Result |
| --- | --- |
| empty, or starting with `#` | ignored |
| `name=value` or `name,value` | parsed; `name` must match `^[A-Za-z][A-Za-z0-9_]*$` and be canonical |
| anything else | ignored silently |
| canonical name with a non-finite value | recorded in `malformed` and reported in the sample note |

The separator is `=` or `,`, surrounded by optional whitespace. Everything after the separator
is passed to `Number()`, so `52 °C` fails (malformed) while `52.0` and ` 52 ` succeed.

A probe that exits non-zero, is killed by the timeout, or cannot be spawned yields
`error !== null`; the caller reports a degraded sample and keeps whatever it already measured.
The error message for a timeout is `command probe timed out after <N> ms`.

### Reading a GPU temperature on Windows

`nvidia-smi` writes CSV by default and cannot be told to write `name=value`, so the probe is a
one-line PowerShell wrapper that runs it and prints the canonical lines. This exact approach is
verified on a machine with an NVIDIA GPU: `nvidia-smi --query-gpu=temperature.gpu,utilization.gpu
--format=csv,noheader` prints `52, 4 %`.

```powershell
# C:\dsh\gpu-temp.ps1
# Prints canonical metric lines for the hardware provider.
# No shell is involved: the plugin runs this via execFile with the argv below.
$raw = & nvidia-smi --query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader 2>$null
if ($LASTEXITCODE -ne 0 -or -not $raw) { exit 1 }   # non-zero exit => degraded sample, not zero
$parts = ($raw | Select-Object -First 1) -split ','
$temp  = [double]($parts[0].Trim())
$usage = [double]($parts[1].Trim() -replace '[^0-9.]', '') / 100.0
Write-Output ("gpu_temp_c={0}" -f $temp)
Write-Output ("gpu_usage={0}" -f $usage)
```

```yaml
providerOptions:
  hardware:
    helperCommand: ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\dsh\\gpu-temp.ps1']
    helperTimeoutMs: 5000
```

That produces exactly the two lines the provider wants:

```text
gpu_temp_c=52
gpu_usage=0.04
```

Notes and honest limits:

- `powershell` must be on `PATH`. `execFile` resolves the executable through `PATH`/`PATHEXT`
  on Windows, so the bare name works; use an absolute path
  (`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`) if it is not.
- A non-zero exit is the recommended way to signal "no reading". The plugin turns that into a
  degraded sample, which the pressure model scores as `unknown` — never as `0`.
- For CPU temperature there is no portable source. `Get-CimInstance -Namespace root/WMI -ClassName
  MSAcpi_ThermalZoneTemperature` returns `CurrentTemperature` in tenths of a Kelvin
  (`(x / 10) - 273.15` gives Celsius) where the firmware exposes it, but it frequently fails with
  "not supported" on desktop motherboards, and it was verified to fail on the machine this
  documentation was written on. Chipset-specific tools are the realistic source.
- A helper runs **with your privileges**. `-ExecutionPolicy Bypass` on a script you wrote is
  fine; pointing `helperCommand` at a downloaded script is not a plugin problem to solve.

## Adding a custom sensor

1. **If the quantity already has a canonical name, use it.** A new probe that emits
   `gpu_temp_c=…` is scored by the existing thermal band with no configuration change at all.
   This is the intended path and covers almost everything.
2. **If the quantity is a new *source* for an existing metric, but you do not want it scored**,
   add the name to `providerOptions.hardware.ignoreMetrics` or delete the metric's `band` in
   `metrics` so it contributes only a trend term.
3. **If the quantity is genuinely new**, the canonical registry must be extended in
   `src/types/metrics.ts`: add the name to the `CanonicalMetric` union, add a descriptor to
   `METRICS` (unit, polarity, group, optional `hardMin`/`hardMax`, description), add a default
   entry to `DEFAULT_METRIC_CONFIG` if it should be scored, and add it to `METRIC_DIMENSION` in
   `src/core/pressure.ts` **and** to the relevant `provides` list in a provider. Miss the last
   two and the metric will be collected and silently ignored by the pressure model — which is a
   legitimate choice, but it should be a deliberate one.
4. **Rebuild and re-verify.** `npm run build`, then `npm test`. `tests/normalization.test.js`
   asserts that every canonical name has a descriptor, that the registry keys are sorted and
   unique, and that the vocabulary has at least 40 entries. Adding a metric without adding it to
   a provider's `provides` list is not caught by a test.

A provider may not invent a metric name. `normalizeSample` rejects an unknown key with a
`not_canonical` violation and a warning, so an unsupported name is visible rather than silently
dropped.

## Rejected documents and their messages

`ConfigError` messages are built as
`health-scheduler config: <path> <message>`, so they name the exact leaf. A selection:

| Document | Message fragment |
| --- | --- |
| `{ "metrics": { "gpu_temp": {} } }` | `metrics.gpu_temp is not a canonical metric; known names: …` |
| `{ "metrics": { "gpu_temp_c": { "band": { "warn": 80, "critical": 80 } } } }` | `metrics.gpu_temp_c.band warn and critical must differ` |
| `{ "thresholds": { "throttle": { "enter": 55, "exit": 55 } } }` | `thresholds.throttle requires exit < enter for hysteresis, received exit=55 enter=55` |
| `{ "thresholds": { "pause_new_work": { "enter": 50, "exit": 40 } } }` | `thresholds.pause_new_work.enter must be strictly above thresholds.throttle.enter (55)` |
| `{ "windows": { "windowsMs": [] } }` | `windows.windowsMs must be a non-empty array of millisecond windows` |
| `{ "windows": { "windowsMs": [300000, 300000] } }` | `windows.windowsMs must be strictly ascending` |
| `{ "weights": { "time": 0, "thermal": 0, "memory": 0, "runtime": 0, "worker": 0, "computer_use_ui": 0 } }` | `weights must have a positive total` |
| `{ "maintenance": { "targetTime": "4:00" } }` | `maintenance.targetTime must be a 24-hour "HH:MM" wall-clock string, received "4:00"` |
| `{ "sampling": { "intervalMs": 0 } }` | `sampling.intervalMs must be > 0, received 0` |
| `{ "providerOptions": { "statsFile": { "commands": [{ "timeoutMs": 1000 }] } } }` | `providerOptions.statsFile.commands[0].argv must be a non-empty argv array` |

`format` on a command probe is always forced to `'name-value'`; there is no second format, and
the value you write is ignored rather than validated.
