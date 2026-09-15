# Changelog

All notable changes to `dsh-health-scheduler` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The two plugins can now actually talk to each other.** `dsh-restart` publishes its
  adapter on `ctx.healthScheduler` when its `apply` runs, and this plugin's `apply` reads
  exactly that name, so a profile that lists both bundles wires itself. Before this the
  structural check rejected a manager handed over directly (it has no `capability` field),
  silent fallback to `UnavailableRestartAdapter` followed, and levels 3 and 4 were
  permanently downgraded to `PAUSE_NEW_WORK` with `restart_capability_unavailable` — a
  failure that looked like a policy choice rather than a missing wire.
- **A system-reboot request carries `acknowledgeSystemReboot`.** `dsh-restart` requires
  that field explicitly for `mode: system`; without it the top rung was refused with
  `SYSTEM_REBOOT_NOT_PERMITTED`, so the escalation path existed in the policy and nowhere
  else. Application requests never carry the flag, so a mode change cannot smuggle a reboot
  through.
- **`maintenance.safePointRequired: false` now skips the gate.** It was passing an
  "asked and unanswered" reading where the policy engine wants `null` to mean "do not ask",
  so the setting blocked every restart with `safe_point_unknown` instead of opting out.
- **Process uptime is read fresh on every sample.** The process facade was snapshotted at
  construction, freezing `uptime_seconds` — and therefore the whole `time` dimension,
  weight 0.15 and the design's long-uptime maintenance driver — at whatever the process
  reported when the plugin loaded.

## [0.1.0] - 2026-01-01

Initial release. The whole engine is new; this entry describes the shipped surface rather than a
diff against an earlier version.

### Added

- **Canonical metric registry** (`src/types/metrics.ts`): 42 metric names across seven subsystem
  groups, each with a unit, a polarity, a group and optional hard physical bounds. The registry
  is the single source of truth for units and for which direction raises pressure.
- **Providers** over one `HealthProvider` contract:
  - `hardware` — native `cpu_usage` from `os.cpus()` deltas, plus an optional helper-command
    seam for `cpu_temp_c`, `gpu_temp_c`, `gpu_usage`, `thermal_throttle` and `power_limit_hit`.
  - `memory` — native `ram_total_bytes`, `ram_available_bytes`, `ram_used_ratio` and
    `process_rss_bytes`, plus the same helper seam for commit charge, private bytes and VRAM.
  - `runtime` — native `uptime_seconds` and (when the runtime exposes
    `process.getActiveResourcesInfo()`) `handle_count`, plus an injected `RuntimeFeed` and an
    optional heartbeat file.
  - `workers`, `computer-use`, `ui`, `context` — stats-file and command-probe driven, with no
    native instrumentation of harness or renderer internals.
- **Stats ingestion** (`src/providers/sources.ts`): a JSON stats-file reader that accepts both
  a wrapped `{ metrics: … }` document and a bare metric object, reports non-canonical keys
  instead of folding them in, and refuses stale contents; plus `execFile`-based command probes
  that parse `name=value` / `name,value` lines **without a shell**.
- **Normalization** (`src/core/normalize.ts`): rejects non-numeric, non-finite and
  physically-impossible readings; clamps a `ratio` sent as a percentage (`1.0 < v <= 1.5`) with
  a `clamped` violation; sorts the surviving bag by metric name. Absence is never turned into
  `0`.
- **Rolling windows** (`src/core/rolling.ts`): raw points over `windows.rawMs` (raised to the
  longest statistics window) and mean/max/min buckets over `windows.aggregateRetentionMs`, with
  five-minute statistics windows defaulting to 5 min / 30 min / 2 h / 6 h. Memory is bounded by
  construction.
- **Trend analysis** (`src/core/trend.ts`): least-squares slope in units per hour with sample
  count, span and R² gates; polarity-aware `isWorsening`; `projectToCeiling` growth projection;
  unit-aware formatters.
- **Pressure engine** (`src/core/pressure.ts`): six weighted dimensions, a linear per-metric
  ramp with a sustain gate, a trend term normalized by the metric's band span, and a
  `WORST_WEIGHT = 0.5` blend of the weighted mean with the worst member. Dimensions with no data
  score `null`, weights are renormalized over the dimensions that do have data, and the
  renormalized share is published as `coverage`. An eight-hour-to-fourteen-day uptime ramp
  drives the time dimension.
- **Policy engine** (`src/core/policy.ts`): the `NO_ACTION` → `THROTTLE` → `PAUSE_NEW_WORK` →
  `REQUEST_APP_RESTART` → `REQUEST_SYSTEM_REBOOT` ladder with per-rung hysteresis, debounce for
  level 3 and above, dwell for sub-restart transitions, three cooldown buckets that start on the
  adapter attempt, a repeat guard at the point of action, and a restart gate covering the
  capability, the maintenance window, the safe point and the urgent override.
- **Maintenance scheduling** (`src/core/maintenance.ts`): window plus target plus deferral
  budget plus urgent override, with the six phases `outside_window`, `before_target`,
  `at_target`, `deferred`, `overdue` and `urgent_override`, using local-calendar arithmetic that
  tolerates DST and windows that wrap past midnight.
- **Safe points** (`src/core/safe-point.ts`): a registry of `getMaintenanceReadiness()` sources
  asked concurrently with a per-source timeout, folded worst-first. An unanswered question is
  `null`, never `true`.
- **Scheduler** (`src/core/scheduler.ts`): the tick pipeline, a `HealthSnapshot` covering
  pressure, dimensions, drivers, trends, maintenance, readiness, capabilities, provider status,
  recent decisions and warnings, an injectable clock, six event types, and best-effort
  containment of provider, adapter, safe-point and log failures.
- **Action adapters** (`src/adapters/types.ts`): the `RestartAdapter` and
  `WorkerControlAdapter` contracts, plus `UnavailableRestartAdapter` and
  `UnavailableWorkerControlAdapter` so "restart is impossible" is a normal typed outcome. This
  plugin contains no restart, kill or reboot execution of any kind.
- **Provider registry** (`src/providers/registry.ts`): per-provider circuit breaking with an
  exponential backoff capped at `providerBackoffMaxMs`, and per-round reporting of which
  providers were skipped.
- **Decision log** (`src/audit/decision-log.ts`): a bounded in-memory ring plus an optional
  append-only `decisions.jsonl` that rotates by rename at `storage.maxLogBytes`. Writes are
  best-effort; I/O failures are counted rather than thrown.
- **Presets** (`src/core/presets.ts`): `conservative`, `balanced` and `aggressive`, generated by
  scaling the balanced ladder, cooldowns, deferral budget, urgent-override pressure and dwell
  floors. Shipped as JSON under `presets/` together with a generated JSON Schema
  (`presets/schema.json`) for a whole configuration document.
- **Harness integration** (`src/dsh/`): the Cordis `name` / `inject` / `apply` entry point, the
  `health-scheduler` settings namespace with live `reconfigure`, and three read-only,
  model-facing tools — `health_status` (with `section`: `full` / `pressure` / `maintenance` /
  `providers`), `health_history` (with `metric` and `window_minutes`) and `health_policy` (with
  `action`: `explain` / `config` / `decisions`).
- **Bundle packaging**: `cordis.patch.yml` inserting the `health-scheduler` row with the full
  commented balanced document, so `dsh plugin --profile <name> add dsh-health-scheduler` joins
  the profile's layer stack; `plugin/manifest.json` plus `plugin/manifest.schema.json`
  describing id, kind, entry, install command, required and optional services, provided tools
  and events, action ownership and degradation behaviour.
- **Daily summaries** (`RollingStore.dailySummaries`): aggregate buckets folded into one
  `{count, mean, max, min}` per metric per local calendar day, retained for
  `windows.dailyRetentionMs` (14 days), with means combined by sample count. Published on every
  `HealthSnapshot` as `dailySummaries` and as `daily_summaries` in the JSON payload.
- **Generated preset documents and a schema**: `presets/balanced.json`,
  `presets/conservative.json`, `presets/aggressive.json` and `presets/schema.json`, produced
  from the build output by `scripts/generate-presets.mjs`, with `npm run presets` to regenerate
  and `--check` to assert they are current.
- **`npm run verify:artifacts`** (`scripts/verify-artifacts.mjs`): asserts the package entry
  exports the plugin contract, that no built file imports a `.ts` specifier, that every
  canonical metric resolves through `metricDescriptor`, that the preset ladder is ordered, and
  that `resolveConfig` rejects an inverted band and a non-canonical metric name.
- **Tests**: 155 tests across eight files — metric registry and normalization, band arithmetic
  and the sustain gate, rolling windows (including daily summaries) and trend analysis, the
  action ladder and anti-flapping policy, maintenance phases and safe-point folding, the six
  design scenarios driven end to end, the plugin entry point and its three tools, and the
  provider registry, adapters, scheduler and decision log.

### Notes

- Node `>= 20.11.0`; TypeScript `target: ES2023`, `module: NodeNext`, `strict`,
  `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`.
- The engine under `src/core`, `src/types`, `src/providers`, `src/adapters` and `src/audit` has
  no dependency on the harness; only `src/dsh/` knows about Cordis, through the narrow
  structural interfaces in `src/dsh/context.ts`.
- Four configuration keys are accepted, validated and **ignored**:
  `sampling.summaryIntervalMs`, `resilience.reportDegradedCapability`,
  `providerOptions.computerUse.probeOnTick` and `providerOptions.computerUse.probeTimeoutMs`.
- The `./startup` subpath export points at `./lib/startup.js`, but there is no `src/startup.ts`,
  so that subpath cannot resolve. Nothing imports it.
- `cordis.patch.yml` spells one key `minRsquared` while the resolver reads `minRSquared`. The
  unknown leaf is ignored, so the default `0.5` applies and behaviour is correct, but the line
  is dead.
- Preset thresholds are clamped into `1 … 99` when scaled, so no rung can be scaled out of
  reach. On `aggressive` the `REQUEST_SYSTEM_REBOOT` rung needs a saturated model (99 / 98).
- `TrendAnalyzer` fits raw points only, so a trend horizon longer than `windows.rawMs` returns
  no samples even though 24 hours of aggregates and 14 days of daily summaries are available.
