# The pressure model

[English](pressure-model.md) | [中文](pressure-model.zh.md)

`restart_pressure` is one number between 0 and 100 that a human can argue with. It is built
from six independent dimensions, each of which is built from per-metric ramp scores. This
document states the model exactly as `src/core/pressure.ts` and `src/core/bands.ts` implement
it, and every worked example below was computed by running that code.

```text
metric value -> band ramp (0..100)  ->  sustain gate  ->  + trend term  ->  metric score
                                                                              |
                                       dimension = 0.5 * weighted mean + 0.5 * worst
                                                                              |
                          restart_pressure = sum(score * effectiveWeight)
```

## The six dimensions and their default weights

`PRESSURE_DIMENSIONS` fixes the presentation order; `weights` supplies the numbers. The
nominal weights sum to exactly `1.0` in the balanced preset.

| Dimension | Default weight | Fed by | Typical metrics |
| --- | --- | --- | --- |
| `time` | 0.15 | the uptime ramp, plus `git_operations_per_minute` | `uptime_seconds` |
| `thermal` | 0.20 | `hardware` | `cpu_temp_c`, `gpu_temp_c`, `cpu_usage`, `gpu_usage`, `thermal_throttle`, `power_limit_hit` |
| `memory` | 0.25 | `memory` | `ram_used_ratio`, `ram_available_bytes`, `commit_used_ratio`, `process_rss_bytes`, `process_private_bytes`, `vram_used_ratio` |
| `runtime` | 0.15 | `runtime` | `event_loop_latency_ms`, `heartbeat_delay_ms`, `handle_count`, `thread_count`, `ipc_timeout_rate`, `restart_count` |
| `worker` | 0.15 | `workers`, `context` | `timeout_rate`, `failure_rate`, `retry_rate`, `task_latency_ms`, `queue_delay_ms`, `queued_tasks`, `active_workers`, `task_failure_rate` |
| `computer_use_ui` | 0.10 | `computer-use`, `ui` | `screenshot_latency_ms`, `action_latency_ms`, `render_latency_ms`, `blank_frame_rate`, … |

`requireWeights` demands a finite non-negative number for each of the six keys and a positive
total. It does **not** demand that the total be 1 — the weights are renormalized twice before
they are used, once over the dimensions that have data (see
[coverage](#unknown-handling-and-coverage-renormalization)) and once *within* a dimension over
the metrics that have data. A document whose weights sum to 7 behaves identically to one whose
weights sum to 1, as long as their ratios match.

## The per-metric ramp

### Endpoints come from polarity, not from the numbers

`rampEndpoints(band, polarity)` in `src/core/bands.ts` sorts the two numbers and then decides
which end is which:

```ts
const lo = Math.min(band.warn, band.critical)
const hi = Math.max(band.warn, band.critical)
return polarity === 'lower-is-worse' ? [hi, lo] : [lo, hi]
```

Two consequences, both intentional:

- **A band may be written in either order.** `{warn: 0.8, critical: 0.3}` and
  `{warn: 0.3, critical: 0.8}` describe the same ramp for a `lower-is-worse` metric.
  `tests/normalization.test.js` asserts this directly. The default table writes
  `recovery_rate` as `{warn: 0.8, critical: 0.3}` because that reads better, not because
  anything depends on it.
- **The registry owns polarity.** `scoreMetric` takes polarity as an optional fourth argument
  and falls back to `metricDescriptor(metric)?.polarity ?? 'higher-is-worse'`. A caller cannot
  flip a metric's direction by reordering its band. `warn` is always the *good* end and
  `critical` is always the *bad* end.

### The ramp itself

```ts
const [best, worst] = rampEndpoints(band, polarity)
const span = worst - best
if (span === 0) return value === best ? 0 : 100
const progress = (value - best) / span
if (progress <= 0) return 0
if (progress >= 1) return 100
return Math.round(progress * 100)
```

It is linear with a hard clamp, not a curve with a tail: above `critical` the score stays at
100. `resolveConfig` rejects a band whose `warn` equals its `critical`
(`"warn and critical must differ"`), so the `span === 0` branch is unreachable through
configuration and exists only for direct library callers.

### Verified ramp values

Computed by calling `scoreMetric` with the default balanced bands:

| Metric | `warn` | `critical` | Value | Score |
| --- | --- | --- | --- | --- |
| `gpu_temp_c` | 78 | 92 | 70 | 0 |
| `gpu_temp_c` | 78 | 92 | 78 | 0 |
| `gpu_temp_c` | 78 | 92 | 81 | 21 |
| `gpu_temp_c` | 78 | 92 | 85 | 50 |
| `gpu_temp_c` | 78 | 92 | 88 | 71 |
| `gpu_temp_c` | 78 | 92 | 92 | 100 |
| `gpu_temp_c` | 78 | 92 | 99 | 100 |
| `cpu_temp_c` | 80 | 95 | 84 | 27 |
| `cpu_temp_c` | 80 | 95 | 88 | 53 |
| `cpu_usage` | 0.7 | 0.98 | 0.90 | 71 |
| `gpu_usage` | 0.7 | 0.98 | 0.95 | 89 |
| `thermal_throttle` | 0.01 | 0.5 | 0.05 | 8 |
| `thermal_throttle` | 0.01 | 0.5 | 0 | 0 |
| `ram_used_ratio` | 0.8 | 0.96 | 0.62 | 0 |
| `ram_available_bytes` | 4 GiB | 512 MiB | 3 GiB | 29 |
| `recovery_rate` | 0.8 | 0.3 | 0.5 | 60 |

### The sustain gate

`scoreWithSustain` is the difference between "GPU is at 90 °C" and "GPU has been at 90 °C for
15 minutes". It compares the configured `sustainMs` against the duration the **rolling store**
recorded, and while the gate is unmet the score is `0` — not a high score filtered later:

| Metric | `sustainMs` | Held | Result |
| --- | --- | --- | --- |
| `gpu_temp_c` = 88 | 60 000 | 5 000 | `score: 0`, `rawScore: 71`, `gated: true` |
| `gpu_temp_c` = 88 | 60 000 | 60 000 | `score: 71`, `gated: false` |
| `gpu_temp_c` = 88 | 0 | 0 | `score: 71`, no gate |
| `gpu_temp_c` = `null` | any | any | `score: null` regardless of duration |

The duration is a property of the data, not of when somebody asked. The scheduler computes a
band identity for each recorded value (`bandKeyOf`) and passes it to
`RollingStore.recordBag`, so the store itself times how long the metric has held
`<metric>:warn` or `<metric>:critical`. Leaving a band resets the clock — a metric that
oscillates in and out of `warn` accumulates nothing. `tests/rolling.test.js` pins that with
`declareBand` assertions, and `tests/normalization.test.js` pins the gate itself.

## Dimension score: `WORST_WEIGHT`

`combineScores` blends the weighted mean with the worst member, at a fixed
`WORST_WEIGHT = 0.5`:

```ts
const worst = known.reduce((max, entry) => Math.max(max, entry.score), 0)
const mean  = weighted / weightSum          // weightOf is config.metrics[m]?.weight ?? 1
return Math.round(clamp(mean * 0.5 + worst * 0.5, 0, 100))
```

The design's rule is "the worst metric leads": one critical metric must not be averaged away by
five calm ones. A half-and-half blend is a deliberately blunt instrument — with five calm
metrics and one at 100, the dimension score is 50, which is enough to cross the throttle
threshold on the thermal dimension's 0.20 weight only in combination with something else. If
you want the worst metric to dominate harder, the metric `weight` is the knob: raising a
metric's weight moves both the mean and, indirectly, how much the worst member is diluted.

`combineScores` returns `null` when **no** member has a known score. A dimension whose metrics
are all `null` is unknown, not zero.

The `weightOf` callback is `this.config.metrics[metric]?.weight ?? 1`. A metric with no entry
in `metrics` at all is never evaluated (see below), but a metric with an entry and no explicit
`weight` counts as 1.

### Which metrics are evaluated at all

`evaluateDimension` iterates the metrics mapped to a dimension and **skips any metric with no
entry in `config.metrics`**:

```ts
const metricConfig = this.config.metrics[metric]
if (metricConfig === undefined) continue
```

So a canonical metric that the preset does not configure — `ram_total_bytes`,
`worker_process_count` — never appears in a dimension's `metrics` array at all. It is still
collected, still stored, still visible in `snapshot.metrics` and `health_history`; it simply
has no opinion about pressure.

`evaluateMetric` then returns `null` for a metric that has neither a band nor a trend term, so
a *configured* metric can also be collected-but-unscored: `git_operations_per_minute` and
`active_workers` have entries with a `weight` and nothing else, and they are dropped from the
dimension's evaluation list. The same happens for a banded metric that has never produced a
sample (`store.latest(metric) === null`).

## The trend term

The trend contribution is added **on top of** the band score, and its magnitude is normalized
by a per-metric reference:

```ts
const perHour = Math.abs(trend.slopePerHour)
const reference = this.referenceSlope(metric)          // |critical - warn|, or null with no band
const relative = reference === null ? 1 : clamp(perHour / reference, 0, 2)
const cap = metricConfig.trendCap ?? 25
const trendScore = Math.round(clamp(relative * trendPoints, 0, cap))
if (trendScore > 0) score = clamp((score ?? 0) + trendScore, 0, 100)
```

Three things are easy to get wrong here:

1. **The reference slope is the band span, not a configured number.**
   `referenceSlope` returns `|band.critical - band.warn|`. For `event_loop_latency_ms` that is
   `|400 - 50| = 350`, so a 350 ms/h rise reaches `relative = 1` and earns the full
   `trendPointsPerHour`; `relative` is capped at `2`, so a 700 ms/h rise earns twice the
   points, still subject to `trendCap`.
2. **A metric with no band gets `relative = 1`, always.** `referenceSlope` returns `null` when
   the metric has no band, and `relative` then defaults to `1`. That is why
   `process_rss_bytes` and `process_private_bytes` — the two leak metrics, both bandless — earn
   their full 60 points for *any* trusted positive slope.
3. **The trend is polarity-aware.** `TrendAnalyzer` sets `isWorsening` from the registry's
   polarity: for `higher-is-worse` a rising slope is worsening, for `lower-is-worse` a falling
   slope is. A GPU temperature dropping 20 °C/h produces a strong trend and contributes
   nothing.

### Verified trend terms

`process_rss_bytes` (`trendPointsPerHour: 60`, `trendCap: 60`, no band → `relative = 1`):

| Slope | Trend term |
| --- | --- |
| +50 MB/h | 60 |
| +200 MB/h | 60 |
| +500 MB/h | 60 |
| +1200 MB/h | 60 |

`event_loop_latency_ms` (`trendPointsPerHour: 40`, `trendCap: 20`, reference 350):

| Slope | Trend term |
| --- | --- |
| +50 ms/h | 6 |
| +175 ms/h | 20 |
| +350 ms/h | 20 |
| +700 ms/h | 20 |

`TrendAnalyzer` only reports a slope when the raw samples in the horizon number at least
`trend.minSamples` (3) and span at least `trend.minSpanMs` (5 minutes), and only trusts it when
R² ≥ `trend.minRSquared` (0.5). Below those gates `isWorsening` is `false` and the trend term
is zero, whatever the movement looks like.

Two related metrics exist and are **not** wired into the score: `TrendAnalyzer.projectToCeiling`
projects when a metric will reach a ceiling at its current slope, and `TrendAnalyzer.worsening()`
returns the trusted worsening trends for the snapshot's `trends` array. Neither adds points.

## The time dimension

The `time` dimension is not a band at all. `evaluateTime` ramps total system uptime linearly:

```ts
export const UPTIME_RAMP_START_MS = 8 * 3_600_000        // 8 hours
export const UPTIME_RAMP_FULL_MS  = 14 * 24 * 3_600_000  // 336 hours = 14 days
const score = Math.round(clamp((uptimeMs - START) / (FULL - START), 0, 1) * 100)
```

| Uptime | `time` metric score |
| --- | --- |
| 1 h | 0 |
| 8 h | 0 |
| 24 h | 5 |
| 100 h | 28 |
| 200 h | 59 |
| 336 h (14 d) | 100 |
| 400 h | 100 |

The input is `uptimeMs` passed into `PressureEngine.evaluate`, which the scheduler derives from
the latest `uptime_seconds` reading (`uptimeOf(store)`). When no provider reported uptime,
`uptimeMs` is `null`, the time metric's score is `null`, and the dimension becomes unknown.
Note that this is *system* uptime from the runtime provider, not a configured "restart after
N days" policy: there is no such policy, by design.

The `time` dimension also owns `git_operations_per_minute` — `dimensionOf` maps it there — but
that metric has no band and no trend term, so it contributes nothing.

## The time dimension's `rule` string

For the audit trail, `evaluateTime` renders its rule as
`uptime ramp over 8h..336h`, with the two endpoint hours computed from the constants. The
`MetricPressure.sustainedMs` for this metric is the full uptime in milliseconds, because the
condition "the machine has been up for X" has trivially been held for X.

## Unknown handling and coverage renormalization

This is the rule that the design calls non-negotiable, and it has three parts.

**1. A dimension with no known metric scores `null`.** Not 0. `combineScores` returns `null`
when every member is unknown, `levelOf(null)` is `'unknown'`, and the dimension's summary reads
`"<dimension>: no telemetry (unknown)"`.

**2. Nominal weights are renormalized over the known dimensions.**

```ts
const knownWeight = dimensions.filter(d => d.score !== null).reduce((s, d) => s + d.weight, 0)
const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0)
const coverage    = totalWeight > 0 ? knownWeight / totalWeight : 0
const restartPressure = knownWeight > 0
  ? Math.round(clamp(sum(score * (weight / knownWeight)), 0, 100))
  : null
```

`restartPressure` is `null` — not 0 — when no dimension has data. The registry's own
`PressureSnapshot.coverage` is rounded to three decimals; the report renders it as a
percentage, and the policy engine appends `coverage_NNpct` to every decision's reason list so
a low-confidence decision is labelled as such in the audit trail.

**3. The renormalized share is published.** `DimensionPressure.effectiveWeight` holds the
weight actually used, so a consumer can see that `thermal` counted for a third of the answer
rather than a fifth.

### Worked example: coverage renormalization

Four of six dimensions known, thermal and worker unknown. Nominal total weight 1.0, known
weight 0.65:

| Dimension | Nominal | Score | Effective weight | Contribution |
| --- | --- | --- | --- | --- |
| `time` | 0.15 | 50 | 0.2308 | 11.538 |
| `thermal` | 0.20 | `null` | 0.0000 | — |
| `memory` | 0.25 | 40 | 0.3846 | 15.385 |
| `runtime` | 0.15 | 20 | 0.2308 | 4.615 |
| `worker` | 0.15 | `null` | 0.0000 | — |
| `computer_use_ui` | 0.10 | 10 | 0.1538 | 1.538 |
| | | | **coverage 0.650** | **pressure 33** |

## Worked example: a real tick

This is the actual output of `PressureEngine.evaluate` driven from a `RollingStore` seeded with
20 minutes of 15-second samples, with band identities declared so the sustain gate is
satisfied. The inputs are the ones `tests/scenarios.test.js` uses for its heat-soak scenario:
`gpu_temp_c: 88`, `cpu_temp_c: 84`, `gpu_usage: 0.95`, `cpu_usage: 0.9`,
`thermal_throttle: 0.05`, `power_limit_hit: 0`, `ram_used_ratio: 0.42`,
`process_rss_bytes: 1.5 GB`, `uptime_seconds: 14400` (4 h).

**The thermal dimension, metric by metric:**

| Metric | Value | Metric weight | Score | Contribution to the mean |
| --- | --- | --- | --- | --- |
| `cpu_temp_c` | 84 | 1 | 27 | 27 |
| `cpu_usage` | 0.9 | 1 | 71 | 71 |
| `gpu_temp_c` | 88 | 1 | 71 | 71 |
| `gpu_usage` | 0.95 | 1 | 89 | 89 |
| `power_limit_hit` | 0 | 1.5 | 0 | 0 |
| `thermal_throttle` | 0.05 | 2 | 8 | 16 |
| | | **7.5** | worst = **89** | **274** |

```text
weighted mean = 274 / 7.5 = 36.533
dimension     = round(0.5 * 36.533 + 0.5 * 89) = round(63.267) = 63
```

**The whole picture:**

| Dimension | Nominal | Score | Level | Effective weight |
| --- | --- | --- | --- | --- |
| `time` | 0.15 | 0 | none | 0.2500 |
| `thermal` | 0.20 | **63** | moderate | 0.3333 |
| `memory` | 0.25 | 0 | none | 0.4167 |
| `runtime` | 0.15 | `null` | unknown | 0.0000 |
| `worker` | 0.15 | `null` | unknown | 0.0000 |
| `computer_use_ui` | 0.10 | `null` | unknown | 0.0000 |

```text
coverage = (0.15 + 0.20 + 0.25) / 1.00 = 0.60
pressure = round(0*0.25 + 63*0.3333 + 0*0.4167) = round(21.0) = 21
unknownDimensions = ["runtime", "worker", "computer_use_ui"]
```

The three drivers it produces, with `contribution = round1(score/100) * effectiveWeight`:

| Code | Contribution | Detail |
| --- | --- | --- |
| `gpu_usage_critical` | 0.3 | `gpu_usage=95.00 pp scores 89/100, held 1260s` |
| `cpu_usage_critical` | 0.2 | `cpu_usage=90.00 pp scores 71/100, held 1260s` |
| `gpu_temp_c_critical` | 0.2 | `gpu_temp_c=88.00 °C scores 71/100, held 1260s` |

Note what the example demonstrates: **a machine with 88 °C idle-class CPU load and visible
thermal throttling reaches pressure 21, not 63.** The dimension believes 63; the weighted
total believes 21, because the thermal dimension is only 20 % of the model and two thirds of
the model have no telemetry at all. The report says `coverage 60%` right next to the number,
and the policy engine puts `coverage_60pct` into the reason list. This is the model working as
designed: it refuses to invent confidence it does not have.

### Driver selection

Drivers are only produced for metrics scoring **at least 35**, i.e. at least `low`-to-`moderate`
territory, and only for dimensions with a non-zero nominal weight whose score is known. The
code is `<metric>_slope_high` when a trend term applied and the score is ≥ 35, otherwise it is
dimension-flavoured:

| Dimension | Code pattern |
| --- | --- |
| `thermal` | `<metric>_critical` |
| `memory` | `<metric>_pressure` |
| `runtime` | `runtime_<metric>_degraded` |
| `worker` | `worker_<metric>_elevated` |
| `computer_use_ui` | `interactive_<metric>_degraded` |
| `time` | `uptime_pressure` |

Drivers are sorted by descending contribution and `primaryCause` is the top driver's detail
string, so a report's headline is always a measurement.

## Worked example: nothing measured at all

With an empty store the engine returns:

```text
restartPressure   = null
coverage          = 0
unknownDimensions = ["time","thermal","memory","runtime","worker","computer_use_ui"]
```

`levelOf(null)` is `unknown` for every dimension, `primaryCause` is `null`, and the policy
engine's state machine puts the machine in `DEGRADED` with `NO_ACTION` — because "I cannot see
the machine" is not the same as "the machine is fine".

## Precision and rounding

| Quantity | Rounding |
| --- | --- |
| Metric score | `Math.round(progress * 100)` |
| Dimension score | `Math.round(...)` after the 50/50 blend |
| `restartPressure` | `Math.round(...)` after weighting |
| `coverage` | `Math.round(x * 1000) / 1000` |
| `MetricPressure.sustainedMs` | already milliseconds; the report divides by 1000 for display |
| Driver `contribution` | `Math.round(x * 10) / 10`, after multiplying by the effective weight |
| `effectiveWeight` | full precision; `metricsSnapshot()` renders `toFixed(4)` |

## Summary of the constants

| Constant | Value | Where |
| --- | --- | --- |
| `WORST_WEIGHT` | 0.5 | `src/core/pressure.ts` (module-private) |
| `UPTIME_RAMP_START_MS` | 8 h | `src/core/pressure.ts` (exported) |
| `UPTIME_RAMP_FULL_MS` | 336 h (14 days) | `src/core/pressure.ts` (exported) |
| Default `trendCap` | 25 | `MetricConfig.trendCap` |
| Default metric weight | 1 | `config.metrics[m]?.weight ?? 1` |
| `LEVEL_BOUNDS` | 0 / 35 / 65 / 85 | `src/core/bands.ts` (exported) |
| Driver score floor | 35 | `driverFor` in `src/core/pressure.ts` |
| Trend `relative` ceiling | 2 | `referenceSlope` caller in `src/core/pressure.ts` |
