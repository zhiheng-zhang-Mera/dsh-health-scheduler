# 规范指标注册表

[English](metrics.md) | 中文

`src/types/metrics.ts` 是指标名、单位、极性与物理硬边界的唯一事实来源。每个 provider 只说这
套词表，别的一概不说，因此两个 provider 永远不会用两个不同的名字表达同一个概念。

下面表格中的所有内容都读自源码中的 `METRICS`、`DEFAULT_METRIC_CONFIG` 与 `METRIC_DIMENSION`。
某处写着“写死”时，指的就是那个数字**实际**的作用，而不是它看起来应该有的作用。

## 如何读这些列

| 列 | 含义 |
| --- | --- |
| **指标** | 规范名称。provider 只能上报这个键，不能有别的拼法。 |
| **单位** | `celsius`、`ratio`、`bytes`、`count`、`milliseconds`、`seconds`、`per-minute`。 |
| **极性** | `higher-is-worse` 或 `lower-is-worse`。由注册表持有，而不是由 band 持有。 |
| **硬边界** | 物理上不可能的值会被直接拒绝（超出边界超过相对 `1e-9` 容差）；容差之内的值会被对齐到边界。 |
| **默认 band** | `warn` → `critical` 的爬升。`warn` 得 0 分，`critical` 得 100 分。对 `lower-is-worse` 指标，`warn` 是**较大**的那个数。 |
| **持续时间** | 指标的分数要生效前必须保持其 band 的毫秒数。`0` 表示没有门禁。 |
| **趋势** | `points/h` 与 `cap`。既无 band 又无趋势的指标会被采集，但永远不会被打分。 |
| **来源** | 上报它的 provider id，以及该 provider 是否原生测量它。 |

读数值时有两个单位细节很重要：

- `ratio` 取值 0..1，报告里按百分点渲染（`0.95` 渲染为 `95.00 pp`）。
- 大于 `1.0` 且不超过 `1.5` 的 `ratio` 会被钳制为 `1` 并附一条 `clamped` violation，因为
  provider 把百分比当比率送来是最常见的 provider 错误。超过 `1.5` 的按 `above_hard_max` 拒绝。

## 硬件

Provider id **`hardware`**（`src/providers/hardware.ts`）。六个指标的压力维度全部为
**`thermal`**。

| 指标 | 单位 | 极性 | 硬边界 | 默认 band | 持续时间 | 趋势 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cpu_temp_c` | celsius | higher-is-worse | −20 … 130 | 80 → 95 | 60 秒 | 30 点/时，上限 20 | `hardware`，**仅外部接缝** |
| `gpu_temp_c` | celsius | higher-is-worse | −20 … 130 | 78 → 92 | 60 秒 | 30 点/时，上限 20 | `hardware`，**仅外部接缝** |
| `cpu_usage` | ratio | higher-is-worse | 0 … 1 | 0.7 → 0.98 | 300 秒 | — | `hardware`，**原生** |
| `gpu_usage` | ratio | higher-is-worse | 0 … 1 | 0.7 → 0.98 | 300 秒 | — | `hardware`，**仅外部接缝** |
| `thermal_throttle` | ratio | higher-is-worse | 0 … 1 | 0.01 → 0.5 | 30 秒 | — | `hardware`，**仅外部接缝** |
| `power_limit_hit` | ratio | higher-is-worse | 0 … 1 | 0.05 → 0.6 | 60 秒 | — | `hardware`，**仅外部接缝** |

说明：

- `cpu_usage` 是真实的总体利用率：两次采样之间 `os.cpus()` 时间计数器的差分。它不需要任何
  特权。进程的**第一次**采样返回 `null`，因为差分需要两个点。
- `thermal_throttle` 与 `power_limit_hit` 在热维度内的指标权重分别是 **2** 与 **1.5**。正在
  降频的机器比只是有点热的机器更糟，权重表达的正是这一点。`cpu_usage` 与 `gpu_usage` **没有**
  加权：负载是背景信息，不是损伤。
- `gpu_usage` 没有原生来源。本插件里没有 GPU 计数器。

## 内存

Provider id **`memory`**（`src/providers/memory.ts`）。压力维度 **`memory`**。

| 指标 | 单位 | 极性 | 硬边界 | 默认 band | 持续时间 | 趋势 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ram_total_bytes` | bytes | higher-is-worse | ≥ 0 | 无 | — | — | `memory`，**原生** |
| `ram_available_bytes` | bytes | **lower-is-worse** | ≥ 0 | 4 GiB → 512 MiB | 120 秒 | — | `memory`，**原生** |
| `ram_used_ratio` | ratio | higher-is-worse | 0 … 1 | 0.8 → 0.96 | 120 秒 | — | `memory`，**原生** |
| `commit_used_ratio` | ratio | higher-is-worse | 0 … 1 | 0.8 → 0.96 | 120 秒 | — | `memory`，**仅外部接缝** |
| `process_rss_bytes` | bytes | higher-is-worse | ≥ 0 | **无** | — | 60 点/时，上限 60 | `memory`，原生（见说明） |
| `process_private_bytes` | bytes | higher-is-worse | ≥ 0 | **无** | — | 60 点/时，上限 60 | `memory`，**仅外部接缝** |
| `vram_used_ratio` | ratio | higher-is-worse | 0 … 1 | 0.85 → 0.98 | 120 秒 | — | `memory`，**仅外部接缝** |

说明：

- `ram_total_bytes` 没有 band、没有趋势、也没有配置权重，因此它被采集但从不被打分。它存在的
  目的是让消费者不必再找第二个来源就能渲染“32 GB 中的 11 GB”。如果你给它加一个 band，它在维度
  内的权重默认为 `1`。
- `ram_available_bytes` 是唯一极性为 `lower-is-worse` 的内存指标：可用 4 GiB 是好的一端
  （0 分），512 MiB 是坏的一端（100 分）。把 band 的两个数字写反也会被接受，并归一化为同一条
  爬升。
- `process_rss_bytes` 与 `process_private_bytes` **完全没有 band** —— 这是刻意的。增长才是关键
  信号，所以它们只带趋势项，60 点/小时、上限 60，并且在维度内**权重为 2**，这样 500 MB/h 的泄漏
  不会被平静的 `ram_used_ratio` 平均掉。没有 band 时，只要趋势项为 0，该指标依然会被报告
  （`rule: "collected, not scored"`）。
- 只有当环境提供了 `treeRssBytes` 时，`process_rss_bytes` 才是**进程树**；默认环境不提供，因此
  它是本进程的 RSS。
- `commit_used_ratio`、`process_private_bytes` 与 `vram_used_ratio` 需要平台辅助程序。`memory`
  provider 复用 `providerOptions.hardware.helperCommand` 与 `helperTimeoutMs` 作为该接缝 ——
  不存在单独的 `memory.helperCommand`。

## 运行时

Provider id **`runtime`**（`src/providers/runtime.ts`）。八个指标中有七个的压力维度是
**`runtime`**；**`uptime_seconds` 属于 `time`**，它由 uptime 爬升而不是 band 来评估。

| 指标 | 单位 | 极性 | 硬边界 | 默认 band | 持续时间 | 趋势 | 来源 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `uptime_seconds` | seconds | higher-is-worse | ≥ 0 | **uptime 爬升**（8 时 → 336 时） | — | **0 点/时，上限 0** | `runtime`，**原生** |
| `worker_process_count` | count | higher-is-worse | ≥ 0 | 无 | — | — | `runtime`，仅 `RuntimeFeed` |
| `handle_count` | count | higher-is-worse | ≥ 0 | **无** | — | 8 点/时，上限 15 | `runtime`，原生代理（见说明） |
| `thread_count` | count | higher-is-worse | ≥ 0 | **无** | — | 8 点/时，上限 15 | `runtime`，仅 `RuntimeFeed` |
| `event_loop_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 50 → 400 | 60 秒 | 40 点/时，上限 20 | `runtime`，仅 `RuntimeFeed` |
| `heartbeat_delay_ms` | milliseconds | higher-is-worse | ≥ 0 | 5 000 → 30 000 | 60 秒 | — | `runtime`，仅心跳文件 |
| `restart_count` | count | higher-is-worse | ≥ 0 | 2 → 6 | **0 秒** | — | `runtime`，仅 `RuntimeFeed` |
| `ipc_timeout_rate` | ratio | higher-is-worse | 0 … 1 | 0.01 → 0.1 | 60 秒 | — | `runtime`，仅 `RuntimeFeed` |

说明：

- `uptime_seconds` 很特殊：它配置的 `trendPointsPerHour: 0, trendCap: 0, weight: 1` 记录了一个
  明确决定 —— **不**给它趋势项，因为时间维度本身已经就是一条 uptime 爬升。见
  [pressure-model.zh.md](pressure-model.zh.md#时间维度)。
- `handle_count` 数的是 `process.getActiveResourcesInfo()` 中的 libuv handle 加 timeout。它是
  设计稿中“进程 handle 增长”的代理，而不是操作系统 handle 计数，也是唯一无需集成即被测量的运行时
  指标。
- `restart_count` 的 `sustainMs: 0`，因此它立刻计入。重启次数不是一个会尖峰又会恢复的传感器读数，
  它是一个事实。
- `worker_process_count`、`thread_count`、`restart_count` 与 `ipc_timeout_rate` 没有 band，
  因此即使 feed 提供了它们，也是“被采集但不被打分”。该组中只有带趋势项与带 band 的成员才对运行时
  维度有贡献。
- 插件自己的入口传入 `EMPTY_RUNTIME_FEED`，它对 `eventLoopLatencyMs`、`workerProcessCount`、
  `threadCount`、`restartCount` 与 `ipcTimeoutRate` 一律回答 `null`。**没有集成时，这些指标
  永远是 unknown。**

## Worker（与 context）

Provider id **`workers`** 与 **`context`**（`src/providers/stats-driven.ts`）。十一个指标中有
十个的压力维度是 **`worker`**；**`git_operations_per_minute` 被分派到 `time`**，不是 `worker`。

| 指标 | 单位 | 极性 | 硬边界 | 默认 band | 持续时间 | 趋势 | 指标权重 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `active_workers` | count | higher-is-worse | ≥ 0 | **无** | — | — | 0.25 |
| `queued_tasks` | count | higher-is-worse | ≥ 0 | 20 → 200 | 120 秒 | — | 0.5 |
| `task_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 30 000 → 180 000 | 120 秒 | 30 点/时，上限 20 | 1 |
| `timeout_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 秒 | — | 1.2 |
| `retry_rate` | ratio | higher-is-worse | 0 … 1 | 0.1 → 0.5 | 60 秒 | — | 1 |
| `failure_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 秒 | — | 1.2 |
| `spawn_failure_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 秒 | — | 1 |
| `abnormal_exit_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 秒 | — | 1 |
| `queue_delay_ms` | milliseconds | higher-is-worse | ≥ 0 | 15 000 → 120 000 | 60 秒 | — | 1 |
| `task_failure_rate` | ratio | higher-is-worse | 0 … 1 | 0.05 → 0.3 | 120 秒 | — | 0.5 |
| `git_operations_per_minute` | per-minute | higher-is-worse | ≥ 0 | **无** | — | — | 0.5 |

说明：

- `task_failure_rate` 与 `git_operations_per_minute` 由 **`context`** provider 上报，但分别被
  分派到 **`worker`** 与 **`time`** 维度。注册表里的指标**分组**与压力**维度**是两回事；见
  [policies.zh.md](policies.zh.md#分派指标到维度) 中的分派表。
- `active_workers` 的权重为 `0.25` 且没有 band：忙碌的机器不是生病的机器，但它的 worker 数量
  正是 `THROTTLE` 推导并发上限时的输入。
- `git_operations_per_minute` 有权重，但既无 band 又无趋势项，因此它被采集、被加权，并且
  **永远不会贡献任何分数**。它的存在是为了充当安全点的忙碌信号；目前还没有消费者。

## Computer Use

Provider id **`computer-use`**（`src/providers/stats-driven.ts`）。六个指标的压力维度全部为
**`computer_use_ui`**。

| 指标 | 单位 | 极性 | 硬边界 | 默认 band | 持续时间 | 趋势 |
| --- | --- | --- | --- | --- | --- | --- |
| `screenshot_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 2 000 → 8 000 | 60 秒 | 60 点/时，上限 25 |
| `action_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 1 000 → 5 000 | 60 秒 | 60 点/时，上限 25 |
| `verification_retry_rate` | ratio | higher-is-worse | 0 … 1 | 0.1 → 0.5 | 60 秒 | — |
| `missed_target_rate` | ratio | higher-is-worse | 0 … 1 | 0.05 → 0.3 | 60 秒 | — |
| `recovery_rate` | ratio | **lower-is-worse** | 0 … 1 | 0.8 → 0.3 | 120 秒 | — |
| `desktop_responsiveness_ms` | milliseconds | higher-is-worse | ≥ 0 | 500 → 3 000 | 60 秒 | 60 点/时，上限 25 |

说明：

- `recovery_rate` 是注册表中第二个 `lower-is-worse` 指标：恢复率 `0.8` 得 0 分，`0.3` 得 100
  分。它也是证明趋势极性重要的指标 —— *下降*的 `recovery_rate` 是恶化趋势。
- 三个延迟指标带 60 点/时、上限 25 的趋势项，因为设计稿明确指出持续的
  `0.5 秒 → 1.2 秒 → 2.8 秒 → 5 秒` 爬升比任何单次 5 秒读数更值得关注。

## UI

Provider id **`ui`**（`src/providers/stats-driven.ts`）。四个指标的压力维度全部为
**`computer_use_ui`**。

| 指标 | 单位 | 极性 | 硬边界 | 默认 band | 持续时间 | 趋势 |
| --- | --- | --- | --- | --- | --- | --- |
| `render_latency_ms` | milliseconds | higher-is-worse | ≥ 0 | 250 → 2 000 | 60 秒 | 60 点/时，上限 25 |
| `main_window_heartbeat_ms` | milliseconds | higher-is-worse | ≥ 0 | 2 000 → 10 000 | 60 秒 | — |
| `blank_frame_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 秒 | — |
| `frontend_error_rate` | ratio | higher-is-worse | 0 … 1 | 0.02 → 0.2 | 60 秒 | — |

设计稿把“IPC timeout rate”列在 UI provider 之下。它的规范名是 `ipc_timeout_rate`，归
**`runtime`** provider 所有，而不是 `ui`，因此 UI 集成**不能**通过 stats 文件上报它：
`StatsBackedProvider` 只会从文件中复制属于自己 `provides` 列表的指标。请把它写进 runtime
feed。

## 注册表中完全没有被打分的指标

这些名字是规范的 —— provider 可以上报它们，它们会被存储、按配置计算趋势并渲染 —— 但
balanced 预设中没有任何部分给它们打分：

| 指标 | 原因 |
| --- | --- |
| `ram_total_bytes` | 容量信息，不是压力。 |
| `worker_process_count` | 默认既无趋势也无 band；它是一个计数，不是症状。 |

`src/core/presets.ts` 中的 `DEFAULT_UNSCORED_METRICS` 在运行时计算这个列表 —— 它等于所有
`DEFAULT_METRIC_CONFIG` 中没有条目的注册表键。`DEFAULT_SCORED_METRICS` 是它的补集：40 个带
band、带趋势项或带权重的指标。

## 完整注册表（按字母序）

全部 42 个规范名称，以及各自喂给哪个维度。`dimensionOf()` 对未映射的名字回退到 `runtime`，但
每个规范指标都是有映射的。

| 指标 | 维度 | 分组 |
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

## 等级

0..100 的分数通过 `src/core/bands.ts` 中的 `LEVEL_BOUNDS` 映射为等级：

| 分数 | 等级 |
| --- | --- |
| `null` | `unknown` |
| 恰好 `0` | `none` |
| `1 … 34` | `low` |
| `35 … 64` | `moderate` |
| `65 … 84` | `high` |
| `85 … 100` | `critical` |

`none` 是对真实测量值 0 的真实等级，它刻意区别于 `unknown` —— 后者是根本没有被测量的指标的
等级。`PRESSURE_LEVEL_RANK` 把 `unknown` 排在 `-1`，**低于** `none`，因为排名只用于展示排序；
打分路径在任何地方都单独处理 `null`。

对照构建产物校验这些表格中的任意一行：

```sh
node --test tests/*.test.js --test-name-pattern "canonical metric registry"
node -e "import('./lib/types/metrics.js').then(m => console.table(m.METRICS))"
```
