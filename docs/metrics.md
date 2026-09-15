# Canonical metric registry

[English](metrics.md) | [中文](metrics.zh.md)

`src/types/metrics.ts` is the single source of truth for metric names, units, polarity and
hard physical bounds. Every provider speaks this vocabulary and nothing else, so two
providers can never contribute the same idea under two different names.

Everything in the tables below is read from `METRICS`, `DEFAULT_METRIC_CONFIG` and
`METRIC_DIMENSION` in the source. Where a cell says "burned in", that is what the number
actually does, not what it looks like it should do.

## Reading the columns

| Column | Meaning |
| --- | --- |
| **Metric** | The canonical name. A provider may report this key and no other spelling of it. |
| **Unit** | `celsius`, `ratio`, `bytes`, `count`, `milliseconds`, `seconds`, `per-minute`. |
| **Polarity** | `higher-is-worse` or `lower-is-worse`. Owned by the registry, not by the band. |
| **Hard bounds** | Physically impossible values are rejected outright (outside the bound by more than a relative `1e-9` tolerance); values within the tolerance are snapped to the bound. |
| **Default band** | The `warn` → `critical` ramp. `warn` scores 0 points, `critical` scores 100. For a `lower-is-worse` metric `warn` is the **higher** number. |
| **Sustain** | Milliseconds the metric must hold its band before its score counts. `0` means no gate. |
| **Trend** | `points/h` and `cap`. A metric with neither a band nor a trend is collected and never scored. |
| **Source** | The provider id that reports it, and whether that provider measures it natively. |

Two unit details that matter when reading a value:

- `ratio` values are 0..1, and the report renders them as percentage points (`95.00 pp` for
  `0.95`).
- A `ratio` above `1.0` and at most `1.5` is clamped to `1` with a `clamped` violation, because
  a provider sending a percentage where a ratio is canonical is the single most common
  provider mistake. Above `1.5` it is rejected as `above_hard_max`.

## Hardware

Provider id **`hardware`** (`src/providers/hardware.ts`). Pressure dimension **`thermal`** for
all six metrics.

| Metric | Unit | Polarity | Hard bounds | Default band | Sustain | Trend | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cpu_temp_c` | celsius | higher-is-worse | −20 … 130 | 80 → 95 | 60 s | 30 pts/h, cap 20 | `hardware`, **external seam only** |
| `gpu_temp_c` | celsius | higher-is-worse | −20 … 130 | 78 → 92 | 60 s | 30 pts/h, cap 20 | `hardware`, **external seam only** |
| `cpu_usage` | ratio | higher-is-worse | 0 … 1 | 0.7 → 0.98 | 300 s | — | `hardware`, **native** |
| `gpu_usage` | ratio | higher-is-worse | 0 … 1 | 0.7 → 0.98 | 300 s | — | `hardware`, **external seam only** |
| `thermal_throttle` | ratio | higher-is-worse | 0 … 1 | 0.01 → 0.5 | 30 s | — | `hardware`, **external seam only** |
| `power_limit_hit` | ratio | higher-is-worse | 0 … 1 | 0.05 → 0.6 | 60 s | — | `hardware`, **external seam only** |

Notes:

- `cpu_usage` is a real aggregate utilisation: the delta of `os.cpus()` time counters between
  two samples. It needs no privilege. The **first** sample of a process returns `null`, because
  a delta needs two points.
- `thermal_throttle` and `power_limit_hit` carry metric weights **2** and **1.5** inside the
  thermal dimension. A machine that is throttling is worse than a machine that is merely warm,
  and the weights say so. `cpu_usage` and `gpu_usage` are *not* weighted: load is context, not
  damage.
- `gpu_usage` has no native source. There is no GPU counter in this plugin.

## Memory

Provider id **`memory`** (`src/providers/memory.ts`). Pressure dimension **`memory`**.

| Metric | Unit | Polarity | Hard bounds | Default band | Sustain | Trend | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ram_total_bytes` | bytes | higher-is-worse | ≥ 0 | none | — | — | `memory`, **native** |
| `ram_available_bytes` | bytes | **lower-is-worse** | ≥ 0 | 4 GiB → 512 MiB | 120 s | — | `memory`, **native** |
| `ram_used_ratio` | ratio | higher-is-worse | 0 … 1 | 0.8 → 0.96 | 120 s | — | `memory`, **native** |
| `commit_used_ratio` | ratio | higher-is-worse | 0 … 1 | 0.8 → 0.96 | 120 s | — | `memory`, **external seam only** |
| `process_rss_bytes` | bytes | higher-is-worse | ≥ 0 | **none** | — | 60 pts/h, cap 60 | `memory`, native (see note) |
| `process_private_bytes` | bytes | higher-is-worse | ≥ 0 | **none** | — | 60 pts/h, cap 60 | `memory`, **external seam only** |
| `vram_used_ratio` | ratio | higher-is-worse | 0 … 1 | 0.85 → 0.98 | 120 s | — | `memory`, **external seam only** |

Notes:

- `ram_total_bytes` has no band, no trend and no configured weight, so it is collected but
  never scored. It exists so a consumer can render "11 GB of 32 GB" without a second source.
  It defaults to dimensional weight `1` if you add a band to it.
- `ram_available_bytes` is the one memory metric whose polarity is `lower-is-worse`: 4 GiB
  available is the good end (0 points) and 512 MiB is the bad end (100 points). Writing the
  band with its numbers swapped is accepted and normalizes to the same ramp.
- `process_rss_bytes` and `process_private_bytes` have **no band at all** — deliberately.
  Growth is the signal that matters, so they carry only a trend term, at 60 points/hour with a
  cap of 60, and a **weight of 2** inside the dimension so a 500 MB/h leak is not averaged away
  by a calm `ram_used_ratio`. With no band, the metric is still reported (`rule: "collected,
  not scored"`) when its trend term is zero.
- `process_rss_bytes` is the *process tree* only when the environment supplied
  `treeRssBytes`; the default environment does not, so it is this process's RSS.
- `commit_used_ratio`, `process_private_bytes` and `vram_used_ratio` need the platform helper.
  The `memory` provider reuses `providerOptions.hardware.helperCommand` and
  `helperTimeoutMs` for that seam — there is no separate `memory.helperCommand`.

## Runtime

Provider id **`runtime`** (`src/providers/runtime.ts`). Pressure dimension **`runtime`** for
seven of eight metrics; **`uptime_seconds` belongs to `time`** and is evaluated by the uptime
ramp instead of a band.

| Metric | Unit | Polarity | Hard bounds | Default band | Sustain | Trend | Source |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `uptime_seconds` | seconds | higher-is-worse | ≥ 0 | **uptime ramp** (8 h → 336 h) | — | **0 pts/h, cap 0** | `runtime`, **native** |
| `worker_process_count` | count | higher-is-worse | ≥ 0 | none | — | — | `runtime`, `RuntimeFeed` only |
| `handle_count` | count | higher-is-worse | ≥ 0 | **none** | — | 8 pts/h, cap 15 | `runtime`, native proxy (see note) |
| `thread_count` | count | higher-is-worse | ≥ 0 | **none** | — | 8 pts/h, cap 15 | `runtime`, `RuntimeFeed` only |
| `event_loop_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 50 → 400 | 60 s | 40 pts/h, cap 20 | `runtime`, `RuntimeFeed` only |
| `heartbeat_delay_ms` | milliseconds | higher-is-worse | ≥ 0 | 5 000 → 30 000 | 60 s | — | `runtime`, heartbeat file only |
| `restart_count` | count | higher-is-worse | ≥ 0 | 2 → 6 | **0 s** | — | `runtime`, `RuntimeFeed` only |
| `ipc_timeout_rate` | ratio | higher-is-worse | 0 … 1 | 0.01 → 0.1 | 60 s | — | `runtime`, `RuntimeFeed` only |

Notes:

- `uptime_seconds` is special: its configured `trendPointsPerHour: 0, trendCap: 0, weight: 1`
  records an explicit decision **not** to give it a trend term, because the time dimension
  already *is* an uptime ramp. See [pressure-model.md](pressure-model.md#the-time-dimension).
- `handle_count` counts libuv handles plus timeouts from
  `process.getActiveResourcesInfo()`. It is a proxy for the design's "process handle growth",
  not an OS handle count, and it is the only runtime metric measured without an integration.
- `restart_count` has `sustainMs: 0`, so it counts immediately. A restart count is not a
  sensor reading that can spike and recover; it is a fact.
- `worker_process_count`, `thread_count`, `restart_count` and `ipc_timeout_rate` have no band,
  so they are collected-but-unscored even when a feed supplies them. Only the trend-bearing
  and band-bearing members of this group contribute to the runtime dimension.
- The plugin's own entry point passes `EMPTY_RUNTIME_FEED`, which answers `null` to
  `eventLoopLatencyMs`, `workerProcessCount`, `threadCount`, `restartCount` and
  `ipcTimeoutRate`. **With no integration, every one of those is permanently unknown.**

## Workers (and context)

Provider ids **`workers`** and **`context`** (`src/providers/stats-driven.ts`). Pressure
dimension **`worker`** for ten of eleven metrics; **`git_operations_per_minute` is dispatched
to `time`**, not to `worker`.

| Metric | Unit | Polarity | Hard bounds | Default band | Sustain | Trend | Metric weight |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `active_workers` | count | higher-is-worse | ≥ 0 | **none** | — | — | 0.25 |
| `queued_tasks` | count | higher-is-worse | ≥ 0 | 20 → 200 | 120 s | — | 0.5 |
| `task_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 30 000 → 180 000 | 120 s | 30 pts/h, cap 20 | 1 |
| `timeout_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 s | — | 1.2 |
| `retry_rate` | ratio | higher-is-worse | 0 … 1 | 0.1 → 0.5 | 60 s | — | 1 |
| `failure_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 s | — | 1.2 |
| `spawn_failure_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 s | — | 1 |
| `abnormal_exit_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 s | — | 1 |
| `queue_delay_ms` | milliseconds | higher-is-worse | ≥ 0 | 15 000 → 120 000 | 60 s | — | 1 |
| `task_failure_rate` | ratio | higher-is-worse | 0 … 1 | 0.05 → 0.3 | 120 s | — | 0.5 |
| `git_operations_per_minute` | per-minute | higher-is-worse | ≥ 0 | **none** | — | — | 0.5 |

Notes:

- `task_failure_rate` and `git_operations_per_minute` are reported by the **`context`**
  provider but dispatched to the **`worker`** and **`time`** dimensions respectively. The
  metric *group* in the registry and the pressure *dimension* are different things; see the
  dispatch table in [policies.md](policies.md#dispatch-metrics-to-dimensions).
- `active_workers` has a weight of `0.25` and no band: a busy machine is not a sick machine, but
  its worker count is the input that `THROTTLE` derives a concurrency limit from.
- `git_operations_per_minute` has a weight but neither a band nor a trend term, so it is
  collected, weighted, and **never contributes a point**. It exists as a busy signal for safe
  points; nothing consumes it yet.
## Computer Use

Provider id **`computer-use`** (`src/providers/stats-driven.ts`). Pressure dimension
**`computer_use_ui`** for all six metrics.

| Metric | Unit | Polarity | Hard bounds | Default band | Sustain | Trend |
| --- | --- | --- | --- | --- | --- | --- |
| `screenshot_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 2 000 → 8 000 | 60 s | 60 pts/h, cap 25 |
| `action_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 1 000 → 5 000 | 60 s | 60 pts/h, cap 25 |
| `verification_retry_rate` | ratio | higher-is-worse | 0 … 1 | 0.1 → 0.5 | 60 s | — |
| `missed_target_rate` | ratio | higher-is-worse | 0 … 1 | 0.05 → 0.3 | 60 s | — |
| `recovery_rate` | ratio | **lower-is-worse** | 0 … 1 | 0.8 → 0.3 | 120 s | — |
| `desktop_responsiveness_ms` | milliseconds | higher-is-worse | ≥ 0 | 500 → 3 000 | 60 s | 60 pts/h, cap 25 |

Notes:

- `recovery_rate` is the second `lower-is-worse` metric in the registry: a recovery rate of
  `0.8` scores 0 and `0.3` scores 100. It is also the metric that proves trend polarity
  matters — a *falling* `recovery_rate` is a worsening trend.
- The three latency metrics carry a 60 pts/h trend term with a 25-point cap, because the design
  is explicit that a sustained `0.5 s → 1.2 s → 2.8 s → 5 s` ramp is more interesting than any
  single 5-second reading.

## UI

Provider id **`ui`** (`src/providers/stats-driven.ts`). Pressure dimension
**`computer_use_ui`** for all four metrics.

| Metric | Unit | Polarity | Hard bounds | Default band | Sustain | Trend |
| --- | --- | --- | --- | --- | --- | --- |
| `render_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 250 → 2 000 | 60 s | 60 pts/h, cap 25 |
| `main_window_heartbeat_ms` | milliseconds | higher-is-worse | ≥ 0 | 2 000 → 10 000 | 60 s | — |
| `blank_frame_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 s | — |
| `frontend_error_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 s | — |

The design lists "IPC timeout rate" under the UI provider. It is canonical as
`ipc_timeout_rate` and it is owned by the **`runtime`** provider, not by `ui`, so a UI
integration cannot report it through the stats file: `StatsBackedProvider` copies only the
metrics in its own `provides` list past the file. Write it into the runtime feed instead.

## Metrics in the registry with no scoring at all

These names are canonical — a provider may report them and they will be stored, trended where
configured and rendered — but no part of the balanced preset scores them:

| Metric | Why |
| --- | --- |
| `ram_total_bytes` | Sizing information, not pressure. |
| `worker_process_count` | Not trended or banded by default; it is a count, not a symptom. |

`DEFAULT_UNSCORED_METRICS` in `src/core/presets.ts` computes this list at runtime — it is
every registry key with no entry in `DEFAULT_METRIC_CONFIG`. `DEFAULT_SCORED_METRICS` is the
complement: the 40 metrics that carry a band, a trend term or a weight.

## Full registry, alphabetically

All 42 canonical names, with the dimension each one feeds. `dimensionOf()` falls back to
`runtime` for anything unmapped, but every canonical metric is mapped.

| Metric | Dimension | Group |
| --- | --- | --- |
| `abnormal_exit_rate` | worker | workers |
| `action_latency_ms` | computer_use_ui | computer-use |
| `active_workers` | worker | workers |
| `blank_frame_rate` | computer_use_ui | ui |
| `commit_used_ratio` | memory | memory |
| `cpu_temp_c` | thermal | hardware |
| `cpu_usage` | thermal | hardware |
| `desktop_responsiveness_ms` | computer_use_ui | computer-use |
| `event_loop_latency_ms` | runtime | runtime |
| `failure_rate` | worker | workers |
| `frontend_error_rate` | computer_use_ui | ui |
| `git_operations_per_minute` | **time** | context |
| `gpu_temp_c` | thermal | hardware |
| `gpu_usage` | thermal | hardware |
| `handle_count` | runtime | runtime |
| `heartbeat_delay_ms` | runtime | runtime |
| `ipc_timeout_rate` | runtime | runtime |
| `main_window_heartbeat_ms` | computer_use_ui | ui |
| `missed_target_rate` | computer_use_ui | computer-use |
| `power_limit_hit` | thermal | hardware |
| `process_private_bytes` | memory | memory |
| `process_rss_bytes` | memory | memory |
| `queue_delay_ms` | worker | workers |
| `queued_tasks` | worker | workers |
| `ram_available_bytes` | memory | memory |
| `ram_total_bytes` | memory | memory |
| `ram_used_ratio` | memory | memory |
| `recovery_rate` | computer_use_ui | computer-use |
| `render_latency_ms` | computer_use_ui | ui |
| `restart_count` | runtime | runtime |
| `retry_rate` | worker | workers |
| `screenshot_latency_ms` | computer_use_ui | computer-use |
| `spawn_failure_rate` | worker | workers |
| `task_failure_rate` | **worker** | context |
| `task_latency_ms` | worker | workers |
| `thermal_throttle` | thermal | hardware |
| `thread_count` | runtime | runtime |
| `timeout_rate` | worker | workers |
| `uptime_seconds` | **time** | runtime |
| `verification_retry_rate` | computer_use_ui | computer-use |
| `vram_used_ratio` | memory | memory |
| `worker_process_count` | runtime | runtime |

## Levels

A 0..100 score maps onto a level through `LEVEL_BOUNDS` in `src/core/bands.ts`:

| Score | Level |
| --- | --- |
| `null` | `unknown` |
| exactly `0` | `none` |
| `1 … 34` | `low` |
| `35 … 64` | `moderate` |
| `65 … 84` | `high` |
| `85 … 100` | `critical` |

`none` is a real level for a real measurement of zero, and it is deliberately distinct from
`unknown`, which is the level of a metric that was not measured at all. `PRESSURE_LEVEL_RANK`
ranks `unknown` at `-1`, *below* `none`, because the rank is only used for ordering
presentation; the scoring path treats `null` separately everywhere.

Verify any row in these tables against the build output:

```sh
node --test tests/*.test.js --test-name-pattern "canonical metric registry"
node -e "import('./lib/types/metrics.js').then(m => console.table(m.METRICS))"
```
