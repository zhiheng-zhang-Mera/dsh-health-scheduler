# 压力模型

[English](pressure-model.md) | 中文

`restart_pressure` 是一个 0 到 100 之间、人类可以和它讲道理的数字。它由六个彼此独立的维度
构成，每个维度又由逐指标的爬升分数构成。本文档逐字陈述 `src/core/pressure.ts` 与
`src/core/bands.ts` 实现的模型，下面的每个算例都是运行那段代码算出来的。

```text
指标数值 -> band 爬升 (0..100)  ->  持续时间门  ->  + 趋势项  ->  指标分数
                                                                    |
                                    维度 = 0.5 * 加权均值 + 0.5 * 最差成员
                                                                    |
                        restart_pressure = sum(分数 * effectiveWeight)
```

## 六个维度与默认权重

`PRESSURE_DIMENSIONS` 固定展示顺序；`weights` 提供数字。balanced 预设中名义权重之和恰好是
`1.0`。

| 维度 | 默认权重 | 由谁喂 | 典型指标 |
| --- | --- | --- | --- |
| `time` | 0.15 | uptime 爬升，加上 `git_operations_per_minute` | `uptime_seconds` |
| `thermal` | 0.20 | `hardware` | `cpu_temp_c`、`gpu_temp_c`、`cpu_usage`、`gpu_usage`、`thermal_throttle`、`power_limit_hit` |
| `memory` | 0.25 | `memory` | `ram_used_ratio`、`ram_available_bytes`、`commit_used_ratio`、`process_rss_bytes`、`process_private_bytes`、`vram_used_ratio` |
| `runtime` | 0.15 | `runtime` | `event_loop_latency_ms`、`heartbeat_delay_ms`、`handle_count`、`thread_count`、`ipc_timeout_rate`、`restart_count` |
| `worker` | 0.15 | `workers`、`context` | `timeout_rate`、`failure_rate`、`retry_rate`、`task_latency_ms`、`queue_delay_ms`、`queued_tasks`、`active_workers`、`task_failure_rate` |
| `computer_use_ui` | 0.10 | `computer-use`、`ui` | `screenshot_latency_ms`、`action_latency_ms`、`render_latency_ms`、`blank_frame_rate` …… |

`requireWeights` 要求六个键各自是有限非负数，并要求总和为正。它**不**要求总和为 1 —— 权重在被
使用前会被重新归一化两次：一次在**有数据**的维度之间（见
[缺数据处理与 coverage 重新归一化](#缺数据处理与-coverage-重新归一化)），一次在每个维度**内部**
有分数的指标之间。一份权重总和为 7 的文档与一份总和为 1 的文档行为完全一致，只要它们的比例相同。

## 逐指标爬升

### 端点由极性决定，而不是由数字决定

`src/core/bands.ts` 中的 `rampEndpoints(band, polarity)` 先把两个数字排序，再决定哪端是哪端：

```ts
const lo = Math.min(band.warn, band.critical)
const hi = Math.max(band.warn, band.critical)
return polarity === 'lower-is-worse' ? [hi, lo] : [lo, hi]
```

两个后果，都是有意为之：

- **band 可以按任意顺序书写。** 对 `lower-is-worse` 指标，`{warn: 0.8, critical: 0.3}` 与
  `{warn: 0.3, critical: 0.8}` 描述同一条爬升。`tests/normalization.test.js` 直接断言了这一点。
  默认表把 `recovery_rate` 写成 `{warn: 0.8, critical: 0.3}` 只是因为这样更好读，而不是因为
  有任何东西依赖它。
- **极性由注册表持有。** `scoreMetric` 把极性作为可选的第四个参数，并回退到
  `metricDescriptor(metric)?.polarity ?? 'higher-is-worse'`。调用方无法通过重排 band 来翻转
  某个指标的方向。`warn` 永远是**好**的一端，`critical` 永远是**坏**的一端。

### 爬升本身

```ts
const [best, worst] = rampEndpoints(band, polarity)
const span = worst - best
if (span === 0) return value === best ? 0 : 100
const progress = (value - best) / span
if (progress <= 0) return 0
if (progress >= 1) return 100
return Math.round(progress * 100)
```

它是带硬钳制的线性函数，而不是带尾巴的曲线：超过 `critical` 之后分数保持 100。
`resolveConfig` 会拒绝 `warn` 等于 `critical` 的 band（`"warn and critical must differ"`），
因此 `span === 0` 分支无法通过配置到达，只为直接调用库的场景存在。

### 实际验证过的爬升值

用默认 balanced band 调用 `scoreMetric` 得到：

| 指标 | `warn` | `critical` | 数值 | 分数 |
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

### 持续时间门

`scoreWithSustain` 是“GPU 现在 90 °C”与“GPU 已经 90 °C 持续 15 分钟”之间的差别。它把配置的
`sustainMs` 与**滚动存储**记录的持续时间作比较，而在门未满足时分数是 `0` —— 不是先给高分再被
过滤掉：

| 指标 | `sustainMs` | 已保持 | 结果 |
| --- | --- | --- | --- |
| `gpu_temp_c` = 88 | 60 000 | 5 000 | `score: 0`、`rawScore: 71`、`gated: true` |
| `gpu_temp_c` = 88 | 60 000 | 60 000 | `score: 71`、`gated: false` |
| `gpu_temp_c` = 88 | 0 | 0 | `score: 71`，无门禁 |
| `gpu_temp_c` = `null` | 任意 | 任意 | 无论持续多久都是 `score: null` |

持续时间是数据的属性，而不是“某个人什么时候来问”的属性。调度器为每个被记录的值计算一个 band
身份（`bandKeyOf`）并把它传给 `RollingStore.recordBag`，因此是存储本身在计时该指标保持
`<metric>:warn` 或 `<metric>:critical` 的时间。离开 band 会重置计时 —— 在 `warn` 内外来回
震荡的指标什么都累积不到。`tests/rolling.test.js` 用 `declareBand` 断言钉住了这一点，
`tests/normalization.test.js` 钉住了门本身。

## 维度分数：`WORST_WEIGHT`

`combineScores` 把加权均值与最差成员按固定的 `WORST_WEIGHT = 0.5` 混合：

```ts
const worst = known.reduce((max, entry) => Math.max(max, entry.score), 0)
const mean  = weighted / weightSum          // weightOf 为 config.metrics[m]?.weight ?? 1
return Math.round(clamp(mean * 0.5 + worst * 0.5, 0, 100))
```

设计稿的规则是“最差指标领跑”：一个危重指标不能被五个平静指标平均掉。五五混合是一件刻意粗糙的
工具 —— 五个平静指标加一个 100 分时，维度分数是 50，只有在与其他因素叠加时才足以越过热维度
0.20 权重下的节流阈值。如果你希望最差指标占更主导的地位，指标 `weight` 就是旋钮：提高某个指标的
权重会同时移动均值，并间接改变最差成员被稀释的程度。

当**没有任何**成员有已知分数时，`combineScores` 返回 `null`。所有指标都是 `null` 的维度是
unknown，而不是零。

`weightOf` 回调是 `this.config.metrics[metric]?.weight ?? 1`。完全不在 `metrics` 中的指标根本
不会被评估（见下），但有条目且没有显式 `weight` 的指标按 1 计。

### 到底哪些指标会被评估

`evaluateDimension` 遍历映射到某个维度的指标，并**跳过任何在 `config.metrics` 中没有条目的
指标**：

```ts
const metricConfig = this.config.metrics[metric]
if (metricConfig === undefined) continue
```

因此预设没有配置的规范指标 —— `ram_total_bytes`、`worker_process_count` —— 根本不会出现在维度
的 `metrics` 数组里。它们仍被采集、仍被存储、仍出现在 `snapshot.metrics` 与 `health_history`
中；它们只是对压力没有意见。

`evaluateMetric` 随后对既无 band 又无趋势项的指标返回 `null`，因此一个**已配置**的指标也可能
“被采集但不被打分”：`git_operations_per_minute` 与 `active_workers` 有带 `weight` 的条目但
别的什么都没有，它们会从维度的评估列表中消失。从未产生过采样的带 band 指标
（`store.latest(metric) === null`）同理。

## 趋势项

趋势贡献是**叠加在** band 分数之上的，其量级由逐指标的参考值归一化：

```ts
const perHour = Math.abs(trend.slopePerHour)
const reference = this.referenceSlope(metric)          // |critical - warn|，无 band 时为 null
const relative = reference === null ? 1 : clamp(perHour / reference, 0, 2)
const cap = metricConfig.trendCap ?? 25
const trendScore = Math.round(clamp(relative * trendPoints, 0, cap))
if (trendScore > 0) score = clamp((score ?? 0) + trendScore, 0, 100)
```

这里有三件事很容易搞错：

1. **参考斜率是带宽，不是某个配置数字。** `referenceSlope` 返回
   `|band.critical - band.warn|`。对 `event_loop_latency_ms` 而言是 `|400 - 50| = 350`，
   因此 350 ms/h 的上升达到 `relative = 1` 并拿到完整的 `trendPointsPerHour`；`relative`
   上限为 `2`，所以 700 ms/h 的上升拿到两倍点数，但仍受 `trendCap` 约束。
2. **没有 band 的指标永远得到 `relative = 1`。** 当指标没有 band 时 `referenceSlope` 返回
   `null`，`relative` 于是默认为 `1`。这就是为什么 `process_rss_bytes` 与
   `process_private_bytes` —— 两个泄漏指标，都没有 band —— 对**任何**可信的正斜率都拿满 60 分。
3. **趋势是极性感知的。** `TrendAnalyzer` 依据注册表的极性设置 `isWorsening`：对
   `higher-is-worse` 是上升为恶化，对 `lower-is-worse` 是下降为恶化。GPU 温度每小时下降
   20 °C 会产生一条很强的趋势，并且贡献为零。

### 实际验证过的趋势项

`process_rss_bytes`（`trendPointsPerHour: 60`、`trendCap: 60`、无 band → `relative = 1`）：

| 斜率 | 趋势项 |
| --- | --- |
| +50 MB/h | 60 |
| +200 MB/h | 60 |
| +500 MB/h | 60 |
| +1200 MB/h | 60 |

`event_loop_latency_ms`（`trendPointsPerHour: 40`、`trendCap: 20`、参考值 350）：

| 斜率 | 趋势项 |
| --- | --- |
| +50 ms/h | 6 |
| +175 ms/h | 20 |
| +350 ms/h | 20 |
| +700 ms/h | 20 |

只有当跨度内的原始样本数量不少于 `trend.minSamples`（3）、跨度不短于 `trend.minSpanMs`
（5 分钟），并且 R² ≥ `trend.minRSquared`（0.5）时，`TrendAnalyzer` 才报告斜率。低于这些门槛时
`isWorsening` 为 `false`，趋势项为零，无论移动看起来多明显。

还有两个相关机制存在，但**没有**接入分数：`TrendAnalyzer.projectToCeiling` 按当前斜率预测某指标
何时触及上限；`TrendAnalyzer.worsening()` 返回快照 `trends` 数组所用的可信恶化趋势。两者都不加
分。

## 时间维度

`time` 维度根本不是 band。`evaluateTime` 对系统总 uptime 做线性爬升：

```ts
export const UPTIME_RAMP_START_MS = 8 * 3_600_000        // 8 小时
export const UPTIME_RAMP_FULL_MS  = 14 * 24 * 3_600_000  // 336 小时 = 14 天
const score = Math.round(clamp((uptimeMs - START) / (FULL - START), 0, 1) * 100)
```

| Uptime | `time` 指标分数 |
| --- | --- |
| 1 时 | 0 |
| 8 时 | 0 |
| 24 时 | 5 |
| 100 时 | 28 |
| 200 时 | 59 |
| 336 时（14 天） | 100 |
| 400 时 | 100 |

输入是传入 `PressureEngine.evaluate` 的 `uptimeMs`，调度器从最新的 `uptime_seconds` 读数导出
它（`uptimeOf(store)`）。当没有 provider 上报 uptime 时，`uptimeMs` 为 `null`，时间指标的分数
为 `null`，维度变成 unknown。注意这是来自 runtime provider 的**系统** uptime，而不是某个“运行
N 天后重启”的配置策略：按设计，不存在这样的策略。

`time` 维度还拥有 `git_operations_per_minute` —— `dimensionOf` 把它映射到那里 —— 但该指标既无
band 又无趋势项，因此它不贡献任何东西。

## 时间维度的 `rule` 字符串

为了审计轨迹，`evaluateTime` 把它的 rule 渲染为 `uptime ramp over 8h..336h`，两个端点小时
由常量算出。该指标的 `MetricPressure.sustainedMs` 就是完整 uptime 的毫秒数，因为“机器已经运行
了 X”这个条件显然已经保持了 X。

## 缺数据处理与 coverage 重新归一化

这就是设计稿称为不可协商的规则，它有三部分。

**1. 没有已知指标的维度得分为 `null`。** 不是 0。当每个成员都未知时 `combineScores` 返回
`null`，`levelOf(null)` 是 `'unknown'`，维度摘要是 `"<dimension>: no telemetry (unknown)"`。

**2. 名义权重在有数据的维度之间重新归一化。**

```ts
const knownWeight = dimensions.filter(d => d.score !== null).reduce((s, d) => s + d.weight, 0)
const totalWeight = dimensions.reduce((s, d) => s + d.weight, 0)
const coverage    = totalWeight > 0 ? knownWeight / totalWeight : 0
const restartPressure = knownWeight > 0
  ? Math.round(clamp(sum(score * (weight / knownWeight)), 0, 100))
  : null
```

当没有任何维度有数据时 `restartPressure` 是 `null` —— 不是 0。注册表自己的
`PressureSnapshot.coverage` 保留三位小数；报告按百分比渲染它，而策略引擎把 `coverage_NNpct`
追加到每条决策的理由列表中，因此低置信度的决策在审计轨迹里就是被如此标注的。

**3. 重新归一化后的份额会被发布。** `DimensionPressure.effectiveWeight` 保存实际使用的权重，
因此消费者可以看到 `thermal` 在这次答案里只占了三分之一，而不是五分之一。

### 算例：coverage 重新归一化

六个维度中四个已知，thermal 与 worker 未知。名义总权重 1.0，已知权重 0.65：

| 维度 | 名义 | 分数 | 有效权重 | 贡献 |
| --- | --- | --- | --- | --- |
| `time` | 0.15 | 50 | 0.2308 | 11.538 |
| `thermal` | 0.20 | `null` | 0.0000 | — |
| `memory` | 0.25 | 40 | 0.3846 | 15.385 |
| `runtime` | 0.15 | 20 | 0.2308 | 4.615 |
| `worker` | 0.15 | `null` | 0.0000 | — |
| `computer_use_ui` | 0.10 | 10 | 0.1538 | 1.538 |
| | | | **coverage 0.650** | **压力 33** |

## 算例：一次真实的 tick

以下是用 20 分钟、每 15 秒一个采样喂给 `RollingStore` 后，`PressureEngine.evaluate` 的真实
输出；band 身份已声明，因此持续时间门被满足。输入就是 `tests/scenarios.test.js` 热 soak 场景
使用的那一组：`gpu_temp_c: 88`、`cpu_temp_c: 84`、`gpu_usage: 0.95`、`cpu_usage: 0.9`、
`thermal_throttle: 0.05`、`power_limit_hit: 0`、`ram_used_ratio: 0.42`、
`process_rss_bytes: 1.5 GB`、`uptime_seconds: 14400`（4 小时）。

**热维度，逐指标：**

| 指标 | 数值 | 指标权重 | 分数 | 对均值的贡献 |
| --- | --- | --- | --- | --- |
| `cpu_temp_c` | 84 | 1 | 27 | 27 |
| `cpu_usage` | 0.9 | 1 | 71 | 71 |
| `gpu_temp_c` | 88 | 1 | 71 | 71 |
| `gpu_usage` | 0.95 | 1 | 89 | 89 |
| `power_limit_hit` | 0 | 1.5 | 0 | 0 |
| `thermal_throttle` | 0.05 | 2 | 8 | 16 |
| | | **7.5** | 最差 = **89** | **274** |

```text
加权均值 = 274 / 7.5 = 36.533
维度     = round(0.5 * 36.533 + 0.5 * 89) = round(63.267) = 63
```

**整体画面：**

| 维度 | 名义 | 分数 | 等级 | 有效权重 |
| --- | --- | --- | --- | --- |
| `time` | 0.15 | 0 | none | 0.2500 |
| `thermal` | 0.20 | **63** | moderate | 0.3333 |
| `memory` | 0.25 | 0 | none | 0.4167 |
| `runtime` | 0.15 | `null` | unknown | 0.0000 |
| `worker` | 0.15 | `null` | unknown | 0.0000 |
| `computer_use_ui` | 0.10 | `null` | unknown | 0.0000 |

```text
coverage = (0.15 + 0.20 + 0.25) / 1.00 = 0.60
压力     = round(0*0.25 + 63*0.3333 + 0*0.4167) = round(21.0) = 21
unknownDimensions = ["runtime", "worker", "computer_use_ui"]
```

它产出的三个 driver，`contribution = round1(score/100) * effectiveWeight`：

| Code | 贡献 | Detail |
| --- | --- | --- |
| `gpu_usage_critical` | 0.3 | `gpu_usage=95.00 pp scores 89/100, held 1260s` |
| `cpu_usage_critical` | 0.2 | `cpu_usage=90.00 pp scores 71/100, held 1260s` |
| `gpu_temp_c_critical` | 0.2 | `gpu_temp_c=88.00 °C scores 71/100, held 1260s` |

注意这个算例展示了什么：**一台 CPU 负载达到 88 °C 级别并且可见热降频的机器，压力只到 21，而
不是 63。** 维度相信 63；加权总数相信 21，因为热维度只占模型的 20%，而模型的三分之二根本没有
遥测。报告就在这个数字旁边写着 `coverage 60%`，策略引擎把 `coverage_60pct` 放进理由列表。这
正是模型按设计工作：它拒绝凭空造出它并不拥有的置信度。

### driver 的选择

只有当指标分数**至少为 35**（即至少进入 `low` 到 `moderate` 区间），且该维度的名义权重非零、
分数已知时，才会产生 driver。当趋势项生效且分数 ≥ 35 时代码是 `<metric>_slope_high`，否则按
维度取风格：

| 维度 | Code 模式 |
| --- | --- |
| `thermal` | `<metric>_critical` |
| `memory` | `<metric>_pressure` |
| `runtime` | `runtime_<metric>_degraded` |
| `worker` | `worker_<metric>_elevated` |
| `computer_use_ui` | `interactive_<metric>_degraded` |
| `time` | `uptime_pressure` |

driver 按贡献降序排列，`primaryCause` 是最高 driver 的 detail 字符串，因此报告的头条永远是一个
测量值。

## 算例：什么都测不到

用空的存储时引擎返回：

```text
restartPressure   = null
coverage          = 0
unknownDimensions = ["time","thermal","memory","runtime","worker","computer_use_ui"]
```

每个维度的 `levelOf(null)` 都是 `unknown`，`primaryCause` 是 `null`，策略引擎的状态机把机器置为
`DEGRADED` 且 `NO_ACTION` —— 因为“我看不见这台机器”不等于“这台机器没事”。

## 精度与取整

| 量 | 取整方式 |
| --- | --- |
| 指标分数 | `Math.round(progress * 100)` |
| 维度分数 | 50/50 混合后再 `Math.round(...)` |
| `restartPressure` | 加权后再 `Math.round(...)` |
| `coverage` | `Math.round(x * 1000) / 1000` |
| `MetricPressure.sustainedMs` | 已是毫秒；报告显示时除以 1000 |
| driver `contribution` | 乘以有效权重后 `Math.round(x * 10) / 10` |
| `effectiveWeight` | 全精度；`metricsSnapshot()` 用 `toFixed(4)` 渲染 |

## 常量汇总

| 常量 | 值 | 位置 |
| --- | --- | --- |
| `WORST_WEIGHT` | 0.5 | `src/core/pressure.ts`（模块私有） |
| `UPTIME_RAMP_START_MS` | 8 时 | `src/core/pressure.ts`（已导出） |
| `UPTIME_RAMP_FULL_MS` | 336 时（14 天） | `src/core/pressure.ts`（已导出） |
| 默认 `trendCap` | 25 | `MetricConfig.trendCap` |
| 默认指标权重 | 1 | `config.metrics[m]?.weight ?? 1` |
| `LEVEL_BOUNDS` | 0 / 35 / 65 / 85 | `src/core/bands.ts`（已导出） |
| driver 分数下限 | 35 | `src/core/pressure.ts` 的 `driverFor` |
| 趋势 `relative` 上限 | 2 | `src/core/pressure.ts` 中 `referenceSlope` 的调用处 |
