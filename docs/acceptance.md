# Acceptance

[English](acceptance.md) | [中文](acceptance.zh.md)

This document maps the design document's acceptance criteria and key scenarios onto the tests
that actually verify them. Every test name below is real and the suite passes as committed:

```sh
node --test tests/*.test.js
# tests 148 / suites 27 / pass 148 / fail 0
```

Test files:

| File | Suites | What it covers |
| --- | --- | --- |
| `tests/normalization.test.js` | `canonical metric registry`, `normalizeSample`, `band scoring`, `sustain gate` | The vocabulary, the physical bounds, the ramp, the sustain gate. |
| `tests/rolling.test.js` | `RollingStore`, `daily summaries`, `TrendAnalyzer` | Window statistics, retention floors, band timing, the per-day rollup, slope and R² gates, projections, formatting. |
| `tests/policy.test.js` | `action ladder`, `anti-flapping`, `restart gate`, `machine states` | Thresholds, hysteresis, debounce, dwell, cooldowns, the restart gate, the state machine. |
| `tests/maintenance.test.js` | `wall-clock parsing`, `maintenance picture`, `safe points` | Window arithmetic, all six phases, the deferral ledger inputs, safe-point folding. |
| `tests/scenarios.test.js` | `synthetic scenarios`, `synthetic scenario invariants`, `scenario rig self-checks` | The six design cases end to end through the real scheduler, plus invariants and rig self-checks. |
| `tests/plugin.test.js` | `plugin exports`, `applyHealthScheduler`, `model-facing tools`, `presentation helpers`, `external telemetry seams` | The Cordis contract, the "nothing that could restart or kill a process" export check, settings registration, the three tools, the report renderers, and the stats-file / command-probe seams. |
| `tests/scheduler.test.js` | `ProviderRegistry`, `unavailable adapters`, `HealthScheduler`, `DecisionLog`, `scheduler clock discipline` | Circuit breaking and exponential backoff, the unavailable adapters, the tick pipeline and cooldown bounding, log rotation and read-back, tick cadence. |

Harness: `tests/helpers/rig.js` (a `ScenarioRig` with an injectable clock, scripted providers,
recording adapters and a scripted safe point) and `tests/helpers/drive.js` (the shared action,
state and reason vocabulary, plus the `drive()` loop). `tests/plugin.test.js` and
`tests/scheduler.test.js` build fake harness contexts directly rather than through the rig.

## The acceptance criteria

The design's section 27 lists these as checkboxes. The source document contains **18** checked
boxes (the brief for this documentation calls them 17); all 18 are mapped below. The "verified
by" column names real tests.

| # | Criterion | Verified by | Automated? |
| --- | --- | --- | --- |
| 1 | Contains no `taskkill` / reboot execution logic. | `never exports anything that could restart or kill a process` asserts that no exported member of the package is a child-process, kill, reboot or shutdown primitive. Verified by inspection as well: the only `execFile` call is `runCommandProbe`, which runs a user-configured telemetry probe. | Yes (export surface) |
| 2 | The restart plugin is fully replaceable. | Not asserted by a test. Verified structurally: `RestartAdapter` is a two-method interface, `isRestartAdapter` is a structural check on `ctx.healthScheduler`, and `applyHealthScheduler` accepts an injected `restart` adapter. `RecordingRestartAdapter` in the rig *is* a drop-in replacement, which is what every scenario test uses, and `uses an unavailable restart adapter when dsh-restart is not installed` asserts the fallback. | **Partial** |
| 3 | Every provider can fail independently. | `records provider failures without stopping the loop`; `contains a throwing provider and keeps the others` | Yes |
| 4 | A single provider going down does not affect overall operation. | `contains a throwing provider and keeps the others`; `applies an exponential backoff after the failure limit and retries later` (the failing provider is skipped while the round still returns the others); `honours the disabled list and per-provider enable flag without failing` | Yes |
| 5 | With no telemetry the state is `unknown`, not `healthy`. | `returns unknown, not zero, for a missing value`; `stays unknown for a missing value regardless of duration`; `returns null statistics for a metric with no data instead of zero`; `marks the state DEGRADED when no telemetry is available at all`; `omits absent metrics instead of inventing zero`; `produces a snapshot with unknown dimensions when nothing is registered`; `reports an unconfigured stats source as unknown, never as zero`; `health_status returns a readable report and never claims unknown is healthy` | Yes |
| 6 | A transient high temperature does not trigger a restart. | `a transient GPU spike never reaches pressure at all`; also `scores zero while the condition has not been held long enough` | Yes |
| 7 | A long-term trend can raise pressure. | `detects a memory leak as a worsening trend`; `projects when a leak reaches a ceiling`; `a four-hour RSS leak becomes pressure without any OOM` | Yes |
| 8 | A memory-leak trend is recognisable. | `detects a memory leak as a worsening trend`; `a four-hour RSS leak becomes pressure without any OOM` | Yes |
| 9 | Worker abnormal rates reach pressure. | `worker retry storms reach pressure through the worker dimension` | Yes |
| 10 | Computer Use stutter reaches pressure. | `Computer Use degradation raises interactive pressure before anything restarts`; `a frozen UI heartbeat reaches pressure and is reported as a driver` | Yes |
| 11 | Scheduled maintenance uses a window, not a hard time point. | `is outside the window before it opens`; `is before_target inside the window but ahead of the target`; `is at_target exactly on the target instant`; `is deferred while the deferral budget lasts, then overdue`; `never allows a request when the configuration forbids one`; `uses a registered safe point to gate the maintenance request` | Yes |
| 12 | `throttle` is preferred over `restart`. | `a sustained heat soak raises thermal pressure and throttles`; `holds a restart request until the maintenance window opens`; `applies a throttle through the worker-control adapter and releases it on recovery` | Yes |
| 13 | `restart` prefers app over system. | `escalates to a system reboot only above the top threshold`; `maps actions onto cooldown buckets and durations`. The ladder itself is asserted rung by rung in `action ladder`. | Yes |
| 14 | System reboot is used only for the escalation path. | Partly: level 4 requires pressure ≥ its own `enter`, which is strictly above level 3's, and `gateRestart` adds `system_reboot_requires_restart_adapter`. But the reason string `escalation_requested_at_maximum_pressure` is attached unconditionally — there is **no** escalation counter and no restart-outcome feedback, so the engine does not actually verify that an app restart failed first. | **Partial** |
| 15 | Hysteresis exists, avoiding state oscillation. | `holds the active action while pressure sits inside the hysteresis band`; `does not oscillate around a threshold` | Yes |
| 16 | Every decision is explainable. | `produces one explainable reason per applied action`; `never emits an action above the pressure that justifies it`; `records a decision for every applied action and explains it` | Yes |
| 17 | No decision storm over a long run. | `keeps ticking through a restart adapter that throws, without a request storm` (30 minutes, 120 evaluations, bounded to ≤ 3 adapter calls); `does not emit a decision storm over a long run`. There is no 6 h / 12 h / 24 h long-run test. | **Partial** |
| 18 | Uninstalling the plugin does not affect DS-Hns. | Not asserted, and not assertable from inside this plugin. The relevant evidence is structural: `tryResolveConfig` means a bad user document cannot fail the boot, provider, adapter, safe-point and log failures are all contained, tool registration failures are caught per tool, and `starts and stops the loop through apply and dispose` asserts the timer is released. It is containment, not a proof — `upstream.registerProvider` would propagate if a provider id were somehow duplicated. | **Partial** |

The design's list has 18 boxes as written in the source document (numbered 1–18 here); the
brief for this documentation calls them 17 criteria. Either way, five of them are only partly
or not automatically covered.

## The 6 key scenarios

The design's section 26. Each scenario is implemented end to end through the real
`HealthScheduler` with an injectable clock — providers → normalization → rolling windows →
trend → pressure → policy.

### Case 1 — transient high temperature

> GPU 90 °C for 30 seconds. Expected: no restart.

Test: **`a transient GPU spike never reaches pressure at all`**

Drives `HEALTHY_BASELINE` for 2 minutes, then `gpu_temp_c: 90` for 30 seconds sampled every
2 seconds, and asserts `pressure === 0`, `state === 'HEALTHY'`, and that every recorded action
was `NO_ACTION`. The mechanism: `gpu_temp_c` scores 86 raw at 90 °C, but its `sustainMs` is
60 000, so a 30-second hold is gated to 0.

### Case 2 — sustained high temperature

> GPU 88 °C for 20 minutes. Expected: `THROTTLE`; if it cannot recover,
> `REQUEST_APP_RESTART`.

Test: **`a sustained heat soak raises thermal pressure and throttles`**

5 minutes of baseline, then `gpu_temp_c: 88`, `cpu_temp_c: 84`, `gpu_usage: 0.95`,
`cpu_usage: 0.9`, `thermal_throttle: 0.05` for 20 minutes at 15-second ticks. Asserts the
thermal dimension scores above 55, pressure is above 0, and the action set contains
`PAUSE_NEW_WORK` or `THROTTLE` — and specifically that `restart.applicationRequests.length === 0`,
because the maintenance window is closed by default.

The "if it cannot recover" half is covered by **`holds a restart request until the maintenance
window opens`**, which asserts that at pressure 85 the raw candidate is `REQUEST_APP_RESTART`
while the effective action is `PAUSE_NEW_WORK` with state `MAINTENANCE_PENDING`.

Related: **`thermal throttle plus long duration is extreme, and says so`** drives 25 minutes of
93 °C / 92 °C / `thermal_throttle: 0.6` / `power_limit_hit: 0.7` and asserts the thermal
dimension reaches level `critical`, that `thermal_throttle` itself reads `critical`, and that a
matching driver is reported.

### Case 3 — slow memory leak

> RAM usage rising for 4 hours. Expected: trend pressure increases; a safe restart inside the
> maintenance window.

Test: **`a four-hour RSS leak becomes pressure without any OOM`**

240 minutes of a clean 1.2 GB/h RSS ramp on a machine with 20 GiB of 32 GiB free and
`ram_used_ratio: 0.62`. Asserts the memory dimension scores above 40, that `process_rss_bytes`
appears as a worsening trend, that a `memory` driver is reported, and that total pressure is
above 35 — none of which needs an OOM to have happened.

The "safe restart inside the maintenance window" half is covered by
**`requests an application restart inside an open window with a confirmed safe point`** and
**`blocks a restart when the safe point is unknown, because unknown is not yes`**.

### Case 4 — busy but healthy

> Low pressure, maintenance target reached, critical task running. Expected: defer.

Tests: **`is deferred while the deferral budget lasts, then overdue`** and
**`is at_target exactly on the target instant`** build the picture directly;
**`requests an application restart inside an open window with a confirmed safe point`** and
**`blocks a restart when the safe point is unsafe`** show the policy consequence:
`git_commit_in_progress` at pressure 85 yields `PAUSE_NEW_WORK` with reasons
`safe_point_unsafe` and `safe_point_reason_git_commit_in_progress`, and the state machine
records `MAINTENANCE_PENDING`.

### Case 5 — clear runtime degradation

> UI latency rising, worker timeouts rising, memory slope rising. Expected: maintenance
> priority rises rapidly.

Tests: **`a frozen UI heartbeat reaches pressure and is reported as a driver`** (UI at
`render_latency_ms: 2600`, `main_window_heartbeat_ms: 12000`, `blank_frame_rate: 0.25`,
`frontend_error_rate: 0.3` → level `critical` with a matching driver);
**`worker retry storms reach pressure through the worker dimension`** (`timeout_rate: 0.35`,
`failure_rate: 0.28`, `retry_rate: 0.7`, `task_latency_ms: 220000`, `abnormal_exit_rate: 0.25` →
worker level `critical` with a `worker_*` driver);
**`Computer Use degradation raises interactive pressure before anything restarts`** (the design's
0.5 s → 1.2 s → 2.8 s → 5 s screenshot ramp → interactive score above 50 with a worsening trend).

### Case 6 — restart plugin failure

> Expected: Health Scheduler does not crash.

Tests: **`keeps ticking through a restart adapter that throws, without a request storm`**
(a 30-minute run at a 15-second tick with a permanently critical machine and an adapter that
throws on every request: the loop survives, the capability still reads `available`, a
`not applied` warning appears, and total adapter attempts are between 1 and 3);
**`blocks a restart when the restart capability is unavailable`** (capability `unavailable`
→ effective action `PAUSE_NEW_WORK`, reason `restart_capability_unavailable`).

`UnavailableRestartAdapter` — the adapter used when `dsh-restart` is absent — is exercised
indirectly by every policy test that does not override it, and directly by the
`restartCapability: 'unavailable'` case.

## Everything else that is asserted

### The metric vocabulary

| Test | What it pins |
| --- | --- |
| `exposes a descriptor for every metric name` | Every canonical name has a descriptor whose `name` matches and whose `description` is non-empty; the vocabulary has at least 40 entries. |
| `keeps the registry keys sorted and unique` | `CANONICAL_METRICS` is sorted and duplicate-free, so snapshots and diffs are stable. |
| `rejects names outside the vocabulary` | `gpu_temp` is not a metric; `__proto__` and `toString` are not either. |
| `declares hard bounds only where physics justifies them` | `cpu_temp_c.hardMax === 130`, `ram_used_ratio.hardMax === 1`, `process_rss_bytes.hardMax === undefined`, `recovery_rate.polarity === 'lower-is-worse'`, `ram_available_bytes.polarity === 'lower-is-worse'`. |

### Normalization

| Test | What it pins |
| --- | --- |
| `keeps measured values and reports nothing` | A clean sample produces exactly the metrics sent and no violations. |
| `omits absent metrics instead of inventing zero` | An empty bag stays empty; the key is not present. |
| `rejects non-finite and non-numeric readings` | `NaN`, `Infinity` and `'0.5'` produce `not_finite` / `not_a_number` and are dropped. |
| `rejects values outside the physical range` | `cpu_temp_c: 4000` and `cpu_usage: -1` produce `above_hard_max` / `below_hard_min`. |
| `clamps a percentage sent where a ratio is canonical, and says so` | `cpu_usage: 1.2` becomes `1` with a `clamped` violation. |
| `sorts output by metric name for stable snapshots` | Output key order is deterministic. |
| `parses timestamps and rejects nonsense` | `parseSampleTime` returns `null` for `'not-a-date'` and `''`. |

### Band arithmetic

| Test | What it pins |
| --- | --- |
| `scores zero below the warn endpoint and 100 at critical` | `scoreMetric('gpu_temp_c', 70/78/92/99, {78, 92})` → `0/0/100/100`. |
| `ramps linearly in between` | `85 → 50`, `81 → 21`. |
| `accepts a band written in either order` | `recovery_rate` at 0.55 scores 50 for both `{0.8, 0.3}` and `{0.3, 0.8}`; `rampEndpoints` returns `[0.8, 0.3]` for `lower-is-worse` and `[0.8, 0.96]` for `higher-is-worse`. |
| `returns unknown, not zero, for a missing value` | `scoreMetric(…, null, …) === null`; `levelOf(null) === 'unknown'`. |
| `maps scores onto the documented level bands` | `LEVEL_BOUNDS.moderate/high/critical` boundaries. |
| `clamps out-of-range values into the range` | `clamp` in both directions. |

### Sustained conditions

| Test | What it pins |
| --- | --- |
| `scores zero while the condition has not been held long enough` | `score: 0`, `rawScore: 71`, `gated: true` at 5 s of a 60 s gate. |
| `scores the real value once the condition has been held` | `score: 71`, `gated: false` at 60 s. |
| `does not gate when no sustain time is configured` | `sustainMs: 0` scores immediately. |
| `stays unknown for a missing value regardless of duration` | `null` in, `null` out, even after 10 minutes. |
| `tracks consecutive time inside a declared band and resets on band change` | `declareBand` returns 0 on entry, accumulates, and resets on a band change and on leaving every band. |

### Rolling windows and trends

| Test | What it pins |
| --- | --- |
| `computes mean, percentiles and extremes over a window` | 100 points: `min 60`, `max 79.8`, `mean ≈ 69.9`, `p95 ≥ 78`, correct `latest`/`earliest`. |
| `returns null statistics for a metric with no data instead of zero` | `count: 0` and every statistic `null`. |
| `raises the raw floor to the longest statistics window when the floor is shorter` | `rawMs: 5 min` with a 30-minute window becomes `30 min`; 31 of 500 points survive. |
| `honours an explicitly longer raw floor than the longest window` | `rawMs: 12 h` keeps all 700 minutes. |
| `keeps aggregate buckets far beyond the raw horizon` | ≥ 200 buckets after 24 h of 5-minute writes. |
| `reports statistics for every configured window` | One `WindowStats` per window, with monotonically non-decreasing counts. |
| `bounds memory: raw points stay proportional to the retention horizon, not to uptime` | 20 000 writes at 1 Hz against a 30-minute horizon leave ≤ 1 850 points. |
| `detects a memory leak as a worsening trend` | +200 MB/h over 4 h: `direction === 'rising'`, `isWorsening`, `R² > 0.99`, slope within 5 MB/h. |
| `does not call a rising temperature a problem when the fit is noise` | A noisy series has `isWorsening === false` and `R² < 0.5`. |
| `does not treat a falling temperature as worsening` | `direction === 'falling'`, `isWorsening === false` for a `higher-is-worse` metric. |
| `treats a falling recovery_rate as worsening` | `direction === 'falling'`, `isWorsening === true` for a `lower-is-worse` metric. |
| `refuses to report a slope before the minimum observation span` | 5 samples over 5 s → `direction: 'unknown'`, `slopePerHour: null`, summary matches `/insufficient observation/`. |
| `projects when a leak reaches a ceiling` | 500 MB/h toward an 8 GB ceiling projects between 2 h and 5 h. |
| `formats slopes in the metric own unit` | `formatBytes(1.5e9) === '1.40 GB'`, `formatSlopePerHour('gpu_temp_c', 12) === '12.00 °C/h'`. |
| `returns only worsening trends, worst fit first` | Only `process_rss_bytes` is returned from a two-metric store. |

### The action ladder and anti-flapping

| Test | What it pins |
| --- | --- |
| `does nothing below the throttle threshold` | Pressure 40 → `NO_ACTION`, `HEALTHY`. |
| `throttles at the throttle enter threshold` | Pressure 55 → `THROTTLE`, `THROTTLED`, reason `pressure_55_gte_throttle_55`. |
| `pauses new work at the pause threshold` | Pressure 72 → `PAUSE_NEW_WORK`, `PAUSED`. |
| `holds a restart request until the maintenance window opens` | Pressure 85, closed window → candidate `REQUEST_APP_RESTART`, effective `PAUSE_NEW_WORK`, state `MAINTENANCE_PENDING`, reason `maintenance_window_closed`. |
| `requests an application restart inside an open window with a confirmed safe point` | Open window + safe point → `REQUEST_APP_RESTART`, reason `safe_point_confirmed`. |
| `escalates to a system reboot only above the top threshold` | Pressure 96 with an already-escalated state → `REQUEST_SYSTEM_REBOOT`. |
| `holds the active action while pressure sits inside the hysteresis band` | 60 → throttle; 50 holds with `hysteresisHeld === true`; 40 releases to `NO_ACTION` / `HEALTHY`. |
| `does not oscillate around a threshold` | The series `56, 54, 56, 54, …` produces `THROTTLE` on all eight evaluations. |
| `debounces a high-risk action across evaluations` | With `debounceEvaluations: 3`: the first two evaluations are `NO_ACTION` with a `debounce_` reason; the third acts. |
| `holds a transition to a calmer level until the dwell time elapses` | A recovery 15 s in is held with `dwell_suppressed_transition`; at 130 s it goes through. |
| `never delays the first crossing out of NO_ACTION` | With a 10-minute dwell, a fresh pressure-60 crossing throttles immediately. |
| `cooldown suppresses a repeat but not a recovery` | A repeat inside the bucket stays in force with `cooldownActive === true` and kind `throttle`; a recovery to pressure 20 yields `NO_ACTION` / `HEALTHY`. |
| `maps actions onto cooldown buckets and durations` | `THROTTLE`/`PAUSE_NEW_WORK` → `throttle`; `REQUEST_APP_RESTART` → `maintenance`; `REQUEST_SYSTEM_REBOOT` → `escalation`; durations read from config. |

### The restart gate

| Test | What it pins |
| --- | --- |
| `blocks a restart when the restart capability is unavailable` | Effective `PAUSE_NEW_WORK`, reason `restart_capability_unavailable`. |
| `blocks a restart when the safe point is unsafe` | Reasons `safe_point_unsafe` and `safe_point_reason_git_commit_in_progress`. |
| `blocks a restart when the safe point is unknown, because unknown is not yes` | Reason `safe_point_unknown` for `safe: null`. |
| `blocks a restart before the target time even inside the window` | Reason `maintenance_before_target_time`, state `MAINTENANCE_PENDING`. |
| `lets an urgent override escalate past the window` | With `urgent_override` + an unsafe safe point: level 4 goes through with both `urgent_override_active` and `escalation_overrides_safe_point`. |
| `does not delay a critical escalation behind a debounce by accident` | The first of two critical evaluations is held; the second escalates. |

### The state machine

| Test | What it pins |
| --- | --- |
| `walks HEALTHY -> DEGRADED -> THROTTLED -> HEALTHY` | Pressure 50 → `DEGRADED` (above the exit band, below enter); 60 → `THROTTLED`; 10 → `HEALTHY`. |
| `marks the state DEGRADED when no telemetry is available at all` | `pressure: null` → `DEGRADED`. |
| `reaches SAFE_MODE only after a system reboot was requested` | A previous `REQUEST_SYSTEM_REBOOT` plus recovered pressure → `SAFE_MODE`. |

### Maintenance and safe points

| Test | What it pins |
| --- | --- |
| `parses valid times and rejects everything else` | `00:00`, `04:00`, `23:59` accepted; `24:00`, `4:00`, `04:60`, `nope` rejected. |
| `finds the previous and next occurrence of a wall clock time` | Boundary behaviour when `now` is exactly the target. |
| `tolerates a window that wraps past midnight` | `23:00`–`02:00` contains `23:30` and `01:30` but not `12:00`. |
| `formats durations for humans and evidence strings` | `90 s → '1m 30s'`, `3 h 5 m → '3h 5m'`, `0 → '0s'`, `04:05`. |
| `reports disabled when scheduled maintenance is off` | Phase `outside_window`, `nextTargetAt: null`, summary matches `/disabled/`. |
| `is outside the window before it opens` | 02:00 → `outside_window`. |
| `is before_target inside the window but ahead of the target` | 03:45 → `before_target`, `windowClosesInMs === 75 min`, request not allowed. |
| `is at_target exactly on the target instant` | 04:00 → `at_target`, request allowed. |
| `is deferred while the deferral budget lasts, then overdue` | 04:10 → `deferred` (600 000 ms); 04:40 → `overdue` with `max defer exhausted`; a request is allowed in both. |
| `takes the urgent override outside the window` | Pressure 93 at 14:00 → `urgent_override`; 91 → `outside_window`. |
| `never allows a request when the configuration forbids one` | `allowAppRestart: false` blocks a request at pressure 99. |
| `resolves the window across a spring-forward style day boundary` | The target is 04:00 local on four separate days, including a month boundary, proving the arithmetic is on local calendar fields rather than fixed offsets. |
| `reports unknown, not safe, when nothing is registered` | `safe: null`, `reason: 'no_safe_point_source'`, `estimated_state: 'unknown'`. |
| `folds sources worst-first` | All-safe → `true`; one unsafe → `false` with that source's reason; one silent → `null`. |
| `contains a throwing source and a hanging source` | `safe_point_source_failed` and `safe_point_timeout`, both contributing `unknown` after the per-source budget. |
| `unregisters through the disposer` | Removing the only source returns the registry to `safe: null`. |

### Scenario invariants and rig self-checks

| Test | What it pins |
| --- | --- |
| `never emits an action above the pressure that justifies it` | Sweeping `gpu_temp_c` through 40 / 70 / 82 / 86 / 91 / 95, every recorded action is either at or above its band's `exit` and either at or above its `enter` or explicitly justified by a `hysteresis` reason. This is the invariant that catches a ladder regression most cheaply. |
| `produces one explainable reason per applied action` | Every record has a non-empty reason list, no empty reason, at least one machine-readable prefix from the allowed set, a `pressure_` reason unless hysteresis justified it, a non-empty outcome detail and a finite coverage. |
| `drives the same number of ticks it was asked for` | The rig's clock and the scheduler's `lastTickMs` agree. |
| `records provider failures without stopping the loop` | One scripted failure produces `totalFailures: 1`, `totalSuccesses: 3` and four snapshots. |
| `keeps ticking through a restart adapter that throws, without a request storm` | Described under Case 6. |

### The plugin surface (`tests/plugin.test.js`)

| Test | What it pins |
| --- | --- |
| `exposes the Cordis plugin contract` | `name`, `inject` and `apply` are present and shaped as the loader expects. |
| `exposes the documented public API surface` | The exports the README and these docs promise are the exports that exist. |
| `never exports anything that could restart or kill a process` | Criterion 1's automated half: no exported member of the package is a child-process, kill, reboot or shutdown primitive. |
| `registers the three tools and starts monitoring` | `applyHealthScheduler` returns the three tool names and a running scheduler. |
| `registers its settings namespace with the resolved config as the base layer` | The `health-scheduler` namespace is registered with `base: config` and `applies: 'live'`. |
| `runs without a tools service and says so` | A missing `tools` service degrades to a warning, not a failure. |
| `runs without a settings service and says so` | Same for `settings`. |
| `rejects a bad configuration loudly but keeps running on the default preset` | Criterion 18's containment: a `ConfigError` is logged and `balanced` is used instead. |
| `starts and stops the loop through apply and dispose` | The timer is released on dispose. |
| `does not start when the configuration disables it` | `enabled: false` loads the plugin but neither samples nor starts a loop. |
| `uses an unavailable restart adapter when dsh-restart is not installed` | Criterion 2's fallback path and Case 6. |
| `writes the decision log when a state directory is provided` | The audit trail reaches disk when it can. |
| `health_status returns a readable report and never claims unknown is healthy` | Criterion 5 as seen by the model. |
| `health_status supports its sections` | `full` / `pressure` / `maintenance` / `providers`. |
| `health_history returns window statistics as JSON` | The `health_history` payload shape. |
| `health_history rejects a non-canonical metric with a helpful error` | The error names the unknown metric and lists the valid ones. |
| `health_policy explains the ladder, the config and the audit trail` | All three `action` modes. |
| `tool definitions advertise a bounded timeout and a string schema` | Every tool declares a timeout rather than hanging a turn. |
| `takes a first tick on demand when no snapshot exists yet` | A tool call before the first scheduled tick still answers. |
| `renders a compact JSON payload with snake_case keys` | `metricsSnapshot()`'s key contract. |
| `formats a metric row for a table` | `renderMetricRow` renders `unknown` rather than a placeholder number. |
| `renders a report that mentions every section` | No section can be silently dropped from the human report. |
| `parses name=value and name,value command output and ignores unknown names` | The command-probe format, including that a non-canonical name is dropped. |
| `accepts both a wrapped stats document and a bare metric object` | Both stats-file shapes. |
| `reports an unconfigured stats source as unknown, never as zero` | Criterion 5 for the external seam. |
| `reports a missing stats file with a reason` | The detail names the paths that were looked for. |
| `treats a stale stats file as degraded` | `staleAfterMs` refuses old contents rather than scoring them. |
| `reads a stats file into the stats-backed providers` | The four stats-backed providers split one file by their own `provides` lists. |
| `reports a failing helper command as a degraded sample rather than an error` | A helper that exits non-zero degrades the sample instead of throwing. |

### The scheduler and the registry (`tests/scheduler.test.js`)

| Test | What it pins |
| --- | --- |
| `rejects a duplicate provider id` | Registration is idempotent-guarded, so two providers cannot fight over one id. |
| `contains a throwing provider and keeps the others` | Criteria 3 and 4. |
| `applies an exponential backoff after the failure limit and retries later` | The circuit breaker: tolerated failures, then a skip window, then recovery. |
| `honours the disabled list and per-provider enable flag without failing` | `disabledProviders` and `enabled: false`. |
| `notifies failure listeners without letting one break sampling` | A throwing observer cannot stop the round. |
| `report unavailable and refuse without throwing` | `UnavailableRestartAdapter` and `UnavailableWorkerControlAdapter`. |
| `builds audit outcomes from adapter results` | `outcomeForAction`. |
| `produces a snapshot with unknown dimensions when nothing is registered` | Criterion 5 with zero providers: every dimension unknown, pressure `null`, not `0`. |
| `records metrics, computes pressure and keeps coverage honest` | The coverage figure matches the telemetry actually present. |
| `applies a throttle through the worker-control adapter and releases it on recovery` | Criterion 12's mechanism, including the release. |
| `refuses to guess a concurrency target when none is configured or derivable` | `throttleLimit` returns `null` rather than a fabricated limit. |
| `survives an unavailable worker-control adapter` | Mitigation degrades; monitoring continues. |
| `records a decision for every applied action and explains it` | Criterion 16 at the scheduler level. |
| `does not emit a decision storm over a long run` | Criterion 17 at the scheduler level. |
| `starts and stops the periodic loop idempotently` | `start()` twice is one loop; `stop()` is safe. |
| `does not sample at all when disabled` | `enabled: false` short-circuits the tick. |
| `reconfigures live without losing history` | `reconfigure` preserves the store and the policy state. |
| `exposes per-window history for a metric` | `windowsFor()` returns one entry per configured window. |
| `ingests a sample directly and reports normalization violations` | The `ingest()` seam and its violation reporting. |
| `contains a throwing event listener` | A bad subscriber cannot break the loop. |
| `uses a registered safe point to gate the maintenance request` | The safe point reaches the policy through the real scheduler, not only through a hand-built input. |
| `keeps a bounded in-memory ring`, `writes and reads back a JSONL log with a schema version`, `tolerates a truncated trailing line`, `never throws when the log directory cannot be written`, `rotates the file once it exceeds the size budget` | The whole `DecisionLog` contract, including the failure path. |
| `never samples faster than the configured interval when running` | The loop honours `sampling.intervalMs`. |
| `keeps the last tick instant` | `lastTickMs` tracks the injected clock. |
| `reports uptime-derived time pressure through the runtime provider` | The uptime ramp is fed from `uptime_seconds` in the real pipeline, not only in a unit test. |

## Verified automatically versus verified on a real machine

| Area | Automated | Needs a real machine |
| --- | --- | --- |
| Metric vocabulary, bounds, ramp, sustain gate | Yes | — |
| Normalization of malformed readings | Yes | — |
| Rolling windows, retention floors, memory bound | Yes | — |
| Trend detection, R² gate, polarity, projection | Yes | — |
| Pressure model, dimension blend, coverage renormalization | Yes (through the scenario rig and the policy tests) | — |
| Action ladder, hysteresis, debounce, dwell, cooldowns | Yes | — |
| Restart gate and safe-point folding | Yes | — |
| Maintenance phases and wall-clock arithmetic | Yes | — |
| Audit reasons and outcomes | Yes | — |
| `cpu_usage` measured from `os.cpus()` | No — the rig and the fake environment script it | Yes. Whether the delta is sensible on a given machine is a real-machine question. |
| `handle_count` from `process.getActiveResourcesInfo()` | No | Yes. The proxy is only meaningful on a real runtime. |
| `ram_*` and `process_rss_bytes` from `os` | No | Yes. |
| A configured helper command producing parsable lines | **Yes** — `parses name=value and name,value command output and ignores unknown names` and `reports a failing helper command as a degraded sample rather than an error` | Yes, for a real vendor tool such as `nvidia-smi` on real hardware. |
| The stats-file format | **Yes** — `accepts both a wrapped stats document and a bare metric object`, `reports a missing stats file with a reason`, `treats a stale stats file as degraded`, `reads a stats file into the stats-backed providers` | Yes, for a file written by a real integration under real timing. |
| A heartbeat file's mtime tracking a live event loop | No | Yes. |
| Any real restart request reaching `dsh-restart` | No | Yes. The repository contains no `dsh-restart` adapter. |
| Worker-control actually changing concurrency | No | Yes. No harness worker-control service is bound in tests. |
| A real profile boot loading the bundle patch | No | Yes. `dsh --profile web --dump-config` against a real profile is the check. |
| Uninstall leaving DS-Hns unaffected | No | Yes. |
| 6 h / 12 h synthetic and a 24 h soak | No — the Long-Run tier is not implemented | Yes, and the synthetic tiers could be automated |

## Known gaps in coverage

Stated plainly, so a maintainer can decide what to close first. Several gaps from an earlier
revision are now closed and are listed at the end.

1. **No Long-Run tier.** Criterion 17 is verified for 30 minutes of scenario time, not 6 or 12
   hours. A 6-hour synthetic run is cheap with the existing rig (the clock is injected, so it is
   a loop over ticks) and would close the "no decision storm" claim much more convincingly.
2. **No test of `normalizeSample`'s hard-bound snapping.** The `1e-9` relative tolerance path
   (a value just inside the bound is snapped rather than rejected) is not asserted.
3. **No test of `resolveConfig`'s rejection messages.** The validation rules are exercised
   heavily — every test calls `resolveConfig`, and `verify:artifacts` asserts two rejections —
   but the exact `ConfigError` text is not asserted. The table of messages in
   [configuration.md](configuration.md) is documentation, not yet a contract.
4. **No test of the settings *watch* path.** Registration is asserted
   (`registers its settings namespace with the resolved config as the base layer`) and the
   scheduler is asserted to reconfigure live (`reconfigures live without losing history`), but
   the `scope.watch` callback joining the two is not driven end to end.
5. **Criterion 2 is not automated.** Nothing asserts that an arbitrary `RestartAdapter` can be
   substituted and that the decision path behaves identically. The recording adapter already in
   the rig makes this a small test.
6. **No adversarial test of the stats-file reader.** Symlinked paths, a path swapped between
   `existsSync` and `readFileSync`, and an oversized file are discussed in
   [SECURITY.md](../SECURITY.md) but not exercised.
7. **Criterion 14's escalation reason is not backed by an escalation counter.** The reason
   `escalation_requested_at_maximum_pressure` is emitted unconditionally with every level-4
   candidate. Either the counter should be built or the reason string should be changed; a test
   asserting the current behaviour would only freeze the discrepancy.

Closed since the first revision of this document:

- **Provider backoff is covered**: `applies an exponential backoff after the failure limit and
  retries later` drives a provider past `providerFailureLimit` and asserts the skip and recovery.
- **The audit log is covered**: `writes and reads back a JSONL log with a schema version`,
  `tolerates a truncated trailing line`, `never throws when the log directory cannot be written`,
  `rotates the file once it exceeds the size budget`, `keeps a bounded in-memory ring` and
  `writes the decision log when a state directory is provided`.
- **The tool surface and the report renderers are covered** by the four suites in
  `tests/plugin.test.js`, including `never exports anything that could restart or kill a
  process` — criterion 1's automated half.
- **The plugin entry point's containment is partly covered**:
  `rejects a bad configuration loudly but keeps running on the default preset`,
  `runs without a tools service and says so`, `runs without a settings service and says so`,
  `contains a throwing event listener` and `does not sample at all when disabled`.
- **Daily summaries are covered** by the `daily summaries` suite in `tests/rolling.test.js`.
- **Tick cadence is covered** by the `scheduler clock discipline` suite, which asserts the loop
  never samples faster than `sampling.intervalMs`.
