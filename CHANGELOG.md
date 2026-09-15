# Changelog

All notable changes to `dsh-health-scheduler` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

### Known issues

- `cordis.patch.yml` is declared by `package.json` (`dsh.bundle.patch`) and listed in `files`,
  but the file is not present in the repository. Until it is checked in, `dsh plugin add`
  installs the package as a plain dependency and the plugin does not join a profile's bundle
  layer stack.
- `scripts/verify-artifacts.mjs` does not exist, so `npm run verify:artifacts` fails.
- `npm run presets` is documented in `presets/README.md` but is not defined in `package.json`;
  use `node scripts/generate-presets.mjs` (or `--check`).

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
- **Tests**: 87 tests across six files — metric registry and normalization, band arithmetic and
  the sustain gate, rolling windows and trend analysis, the action ladder and anti-flapping
  policy, maintenance phases and safe-point folding, and the six design scenarios driven end to
  end through the real scheduler.

### Notes

- Node `>= 20.11.0`; TypeScript `target: ES2023`, `module: NodeNext`, `strict`,
  `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`.
- The engine under `src/core`, `src/types`, `src/providers`, `src/adapters` and `src/audit` has
  no dependency on the harness; only `src/dsh/` knows about Cordis, through the narrow
  structural interfaces in `src/dsh/context.ts`.
- Four configuration keys are accepted, validated and **ignored**:
  `sampling.persistIntervalMs`, `resilience.reportDegradedCapability`,
  `providerOptions.computerUse.probeOnTick` and `providerOptions.computerUse.probeTimeoutMs`.
- `windows.dailyRetentionMs` is validated but no daily summary rollup exists.
- On `aggressive`, `thresholds.request_system_reboot.enter` is 109, which a 0–100 pressure can
  never reach, so level 4 is unreachable through the threshold path on that preset.
