# 配置参考

[English](configuration.md) | 中文

配置是一份**部分文档**。它会被深合并到 `preset` 指定的预设之上（缺省 → `balanced`），因此你
省略的每个叶子都来自预设。两条合并规则很重要：

- **对象深合并。** 写 `{ "maintenance": { "enabled": true } }` 只改一个叶子，`targetTime`、
  `windowStart` 以及 `maintenance` 中其余部分保持预设值。
- **数组替换。** `windowsMs`、`disabledProviders`、`ignoreMetrics`、`extraPids`、
  `statsFile.paths` 与 `statsFile.commands` 被原样采用；它们从不被追加。
- **`null` 是值，不是删除。** `storage.directory: null` 表示“用默认目录”。接受 `null` 的键
  恰好是 `throttle.concurrencyLimit`、`maintenance.urgentOverridePressure`、
  `storage.directory`、`providerOptions.hardware.helperCommand`、
  `providerOptions.runtime.heartbeatFile`，以及 `providerOptions.statsFile.paths`（作为空数组）。

## 文档放在哪里

三个位置，优先级递增：

1. **bundle patch 行** —— `cordis.patch.yml` 中该插件行的 `config:` 块。
2. **`health-scheduler` 设置命名空间** —— 当 profile 提供设置服务时注册。`scope.watch` 在每次
   变更时调用 `resolveConfig` 并调用 `scheduler.reconfigure`，因此设置变更**实时**生效：历史与
   策略状态被保留，provider 退避窗口被重置。
3. **直接使用库** —— `resolveConfig(overrides)` / `createScheduler({ config, … })`。

无法被执行的文档会被大声拒绝。`resolveConfig` 抛出 `ConfigError`，消息形如
`health-scheduler config: <dotted.path> <explanation>`。插件的 `apply` 使用
`tryResolveConfig`，它会记录错误并回退到 `resolveConfig({ preset: 'balanced' })`，而不是让启动
失败。

整份文档的 JSON Schema 生成在 [`presets/schema.json`](../presets/schema.json)（draft 2020-12），
其约束与 `resolveConfig` 实际执行的检查一致。

## 总开关

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 总开关。为 `false` 时插件仍然加载、仍然注册设置命名空间与工具，但 `HealthScheduler.start()` 立即返回，`tick()` 在采样前短路，什么都不采集也不下发。快照的 `pressure` 保持 `null`。 |
| `preset` | `'conservative'` \| `'balanced'` \| `'aggressive'` \| `'custom'` | `'balanced'` | 选择基础文档。别处的显式值总是胜过预设。无法识别的名字在运行时回退到 `balanced`（`preset()`），这也是 schema 的 enum 不包含其他值的原因。`'custom'` 只作为**标签**被接受 —— 它不是一个预设，会解析为 `balanced`。 |

## `sampling`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `intervalMs` | number > 0 | `15000`（15 秒） | 调度器两拍之间的毫秒数。定时器被 `unref()`，因此它自己永远不会让进程保持存活。 |
| `trendIntervalMs` | number > 0 | `60000`（60 秒） | 与距上次趋势评估的时间比较，用于推进 `lastTrendAt`。**目前没有任何行为依赖它**：`tick()` 每拍都评估趋势，只是更新那个时间戳。 |
| `persistIntervalMs` | number > 0 | `300000`（5 分） | **被接受但被忽略。** 没有任何东西读它；决策日志在每次动作被应用时同步追加。 |
| `providerBackoffMs` | number ≥ 0 | `30000`（30 秒） | provider 熔断退避的基数。`0` 会取消延迟（失败计数仍然递增）。 |
| `providerBackoffMaxMs` | number > 0 | `600000`（10 分） | 指数退避的上限。 |

退避调度是 `providerBackoffMs * 2^min(consecutiveFailures - providerFailureLimit, 8)`，上限为
`providerBackoffMaxMs`；在连续失败数仍低于 `providerFailureLimit` 时它是 `0`。按默认值：三次
失败被自由容忍，然后是 30 秒、60 秒、120 秒……直到 10 分钟。

## `windows`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `rawMs` | number > 0 | `1800000`（30 分） | 原始保留的**下限**。有效值是 `max(rawMs, 最长的 windowsMs 项)`，因此 6 小时的统计窗口永远有完整样本支撑。 |
| `windowsMs` | 非空、严格递增的正数数组 | `[300000, 1800000, 7200000, 21600000]`（5 分、30 分、2 时、6 时） | 计算 `WindowStats` 并由 `health_history` 报告的窗口。 |
| `aggregateBucketMs` | number > 0 | `300000`（5 分） | 长跨度 mean/max/min 序列的桶大小。 |
| `aggregateRetentionMs` | number > 0 | `86400000`（24 时） | 桶保留时长。 |
| `dailyRetentionMs` | number > 0 | `1209600000`（14 天） | **被接受但被忽略。** `0.1.0` 中没有每日汇总，因此没有东西消费这个值。 |

内存由构造方式保证有界：原始点在每次写入时被裁剪到 `rawMs`，桶被裁剪到
`aggregateRetentionMs`，因此存储不随 uptime 增长。

> **趋势跨度是最长的 `windowsMs` 项。** `PressureEngine` 与调度器都把
> `windowsMs[windowsMs.length - 1]` 作为趋势回看跨度传入，而 `TrendAnalyzer` 只对**原始**点
> 做拟合。因此比 `rawMs` 更长的跨度实际拟合到的点比跨度暗示的要少。按默认值，`rawMs` 被抬高
> 到 6 小时以保持一致 —— 但如果你设置 `windowsMs: [5m, 24h]`，跨度变成 24 小时、有效保留也
> 变成 24 小时，对一个 15 秒的 tick 来说这是很大的原始历史量（每指标 5 760 个点）。

## `trend`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `minSamples` | number > 0 | `3` | 报告斜率所需的最少跨度内样本数。被截断为整数并抬高到至少 `2`。 |
| `minSpanMs` | number ≥ 0 | `300000`（5 分） | 报告斜率所需的最短观测跨度。 |
| `minRSquared` | 有限数 | `0.5` | 斜率被信任所需的最低 R²。低于它时 `direction` 是 `'flat'`，`isWorsening` 为 `false`。不做范围检查：大于 1 的值会让所有趋势都不被信任。 |

## `weights`

| 键 | 类型 | 默认 |
| --- | --- | --- |
| `time` | number ≥ 0 | `0.15` |
| `thermal` | number ≥ 0 | `0.2` |
| `memory` | number ≥ 0 | `0.25` |
| `runtime` | number ≥ 0 | `0.15` |
| `worker` | number ≥ 0 | `0.15` |
| `computer_use_ui` | number ≥ 0 | `0.1` |

每个值必须是有限非负数，六个值之和必须为正。总和**不**必须是 1：权重会在有遥测的维度之间重新
归一化，并在每个维度内部对有分数的指标再次归一化。见
[pressure-model.zh.md](pressure-model.zh.md#缺数据处理与-coverage-重新归一化)。

## `thresholds`

四个滞回带。每个是 `{ enter: number, exit: number }`，且**要求** `exit < enter`。

| 键 | 默认 `enter` / `exit` | 作用 |
| --- | --- | --- |
| `throttle` | `55` / `45` | 压力达到或超过 `enter` 时选择 `THROTTLE`；动作保持到压力降到 `exit` 或以下。同时是 `HEALTHY` 与 `DEGRADED` 的分界。 |
| `pause_new_work` | `70` / `60` | 同上，对应 `PAUSE_NEW_WORK`。 |
| `request_app_restart` | `80` / `68` | 同上，对应 `REQUEST_APP_RESTART`。也是驻留生效的等级分界。 |
| `request_system_reboot` | `95` / `85` | 同上，对应 `REQUEST_SYSTEM_REBOOT`。 |

`requireThresholds` 按阶梯顺序（`throttle → pause_new_work → request_app_restart →
request_system_reboot`）额外强制两条跨字段规则：

- `enter` 必须**严格**大于上一级的 `enter`；
- `exit` **不得**低于上一级的 `exit`。

## `metrics`

一个以规范指标名称为键的对象。未知键会被拒绝，错误消息中带完整规范名称列表。每个值是：

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `band` | `{ warn: number, critical: number }` | 预设值 | 爬升端点。`warn` 必须与 `critical` 不同。两种顺序都被接受；由注册表的极性决定哪端是坏的。**省略 `band` 会完全移除该指标的等级分数** —— 它此后只通过趋势项贡献（或者完全不贡献）。 |
| `weight` | number ≥ 0 | `1` | 该指标在其维度内的权重。 |
| `sustainMs` | number ≥ 0 | 逐指标，见 [metrics.zh.md](metrics.zh.md) | 分数生效前必须保持其 band 的毫秒数。`0` 关闭门禁。 |
| `trendPointsPerHour` | number ≥ 0 | `0` | 每小时的受信任恶化斜率在参考斜率归一化之前加的点数。`0` 关闭趋势项。 |
| `trendCap` | number ≥ 0 | `25` | 趋势贡献的上限。 |

默认表、每个 band，以及每个指标由哪个 provider 提供，见 [metrics.zh.md](metrics.zh.md)。验证过的
爬升与趋势数值见 [pressure-model.zh.md](pressure-model.zh.md)。

**完全不在 `metrics` 中的**指标根本不会被评估：它被采集、被存储、被你通过 provider 加入时被计算
趋势、并被渲染 —— 它只是对压力没有意见。balanced 预设刻意省略了 `ram_total_bytes` 与
`worker_process_count`。

## `cooldowns`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `throttleMs` | number ≥ 0 | `300000`（5 分） | `THROTTLE` 与 `PAUSE_NEW_WORK` 的冷却桶。 |
| `maintenanceMs` | number ≥ 0 | `1800000`（30 分） | `REQUEST_APP_RESTART` 的冷却桶。 |
| `escalationMs` | number ≥ 0 | `3600000`（60 分） | `REQUEST_SYSTEM_REBOOT` 的冷却桶。 |

每个冷却从适配器**真正被调用**时开始，包括它拒绝或抛异常的情况。见
[policies.zh.md](policies.zh.md#冷却从尝试而不是决策开始)。

## `throttle`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `concurrencyLimit` | 正整数 \| `null` | `null` | `THROTTLE` 动作请求的显式并发数。为 `null` 时从观测到的 `active_workers` 推导。小数被截断，低于 1 的被抬高到 1。 |
| `concurrencyFactor` | number > 0 | `0.5` | `concurrencyLimit` 为 `null` 时作用于 `active_workers` 的乘数。被钳制到 `0.05 … 1`。 |

推导逻辑，以及刻意的拒绝猜测：

```ts
function throttleLimit(config, activeWorkers) {
  if (config.throttle.concurrencyLimit !== null) return config.throttle.concurrencyLimit
  if (activeWorkers === null || activeWorkers <= 0) return null
  return Math.max(1, Math.floor(activeWorkers * config.throttle.concurrencyFactor))
}
```

| `active_workers` | 推导出的上限（因子 0.5） |
| --- | --- |
| `null`（未知） | `null` → throttle 成为 no-op，并附说明 detail |
| `0` | `null` → 同上 |
| `1` | `1` |
| `3` | `1` |
| `8` | `4` |
| `16` | `8` |

`null` 上限产生 `applied: false`，detail 为
`"no concurrency target configured or derivable; throttle is a no-op"`。要求 harness 去降低
一个未知量，正是健康插件意外停掉所有工作的方式，因此它拒绝这么做。

## `maintenance`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 是否启用定时维护。为 `false` 时阶段永远是 `outside_window`，`nextTargetAt` 为 `null`，`maintenanceAllowsRequest` 返回 `false`。 |
| `targetTime` | `"HH:MM"` 24 小时制 | `'04:00'` | 窗口内的本地墙钟目标时间。 |
| `windowStart` | `"HH:MM"` | `'03:30'` | 允许窗口的本地开始。 |
| `windowEnd` | `"HH:MM"` | `'05:00'` | 允许窗口的本地结束。取值 ≤ `windowStart` 会让窗口跨过午夜。 |
| `maxDeferMs` | number ≥ 0 | `3600000`（60 分） | 越过目标后允许推迟的预算。耗尽后阶段变成 `overdue`，它仍然**允许**请求。 |
| `urgentOverridePressure` | 有限数 \| `null` | `92` | 达到或超过该压力时忽略窗口。`null` 关闭该覆盖。 |
| `allowAppRestart` | boolean | `true` | 是否允许发出维护请求。由 `maintenanceAllowsRequest` 检查；**不**由策略引擎的 `gateRestart` 检查，后者依赖 `enabled` 与窗口。因此把它设为 `false` 会阻止库便利函数，但不会阻止策略路径。 |
| `safePointRequired` | boolean | `true` | 为 `true` 时，重启请求额外要求 `readiness.safe === true`。为 `false` 时根本不查询注册表，readiness 是 `{safe: null, reason: 'safe_point_not_required'}`。 |

六个阶段与精确条件见
[policies.zh.md](policies.zh.md#维护窗口状态机)。

## `antiFlap`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `minStateDwellMs` | number ≥ 0 | `120000`（2 分） | **低于**重启等级的切换前，必须在一个状态中停留的最短时间。从不延迟第一次跨出 `NO_ACTION`。 |
| `minRepeatActionMs` | number ≥ 0 | `600000`（10 分） | 两次相同已应用动作之间的最短时间，独立于桶冷却。 |
| `debounceEvaluations` | number > 0 | `2` | 第 3 级及以上的条件在可动作前必须保持的连续评估次数。`1` 关闭防抖。被截断为整数并抬高到至少 `1`。 |

## `resilience`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `providerFailureLimit` | number > 0 | `3` | 指数退避开始前的连续失败次数。被截断并抬高到至少 `1`。 |
| `providerRetryAfterBackoff` | boolean | `true` | 为 `false` 时，provider 在第一次失败后永不被重试：只要 `consecutiveFailures > 0`，`isAvailable` 就返回 `false`。 |
| `reportDegradedCapability` | boolean | `true` | **被接受但被忽略。** 能力状态始终来自适配器自身的 `capability` 字段。 |

## `storage`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 是否写入磁盘。为 `false` 时 `DecisionLog` 收到 `directory: null`，只保留内存。 |
| `directory` | string \| `null` | `null` | 日志目录。`null` 表示使用环境的 `stateDirectory`。如果后者也是 `null` —— 当 `apply` 调用时没传时就会如此 —— 那么即使 `enabled: true`，日志也只有内存。 |
| `maxLogBytes` | number > 0 | `4194304`（4 MiB） | `decisions.jsonl` 被重命名为 `decisions.jsonl.<ISO 时间戳>.bak` 并新建文件的阈值。 |
| `maxRecentDecisions` | number > 0 | `50` | 用于 UI 与 `health_policy decisions` 的内存环形缓冲大小。被截断并抬高到至少 `1`。 |

日志文件是该目录下的 `decisions.jsonl`；每行是一个 JSON 对象，含 `schemaVersion: 1`、
`kind: 'decision'` 与完整的 `DecisionRecord`。写入是尽力而为且同步的：失败会递增
`DecisionLog.writeFailures` 并设置 `lastError`，而不是抛异常。`readPersisted()` 会跳过写了一半
的尾行。

## `disabledProviders`

一个非空字符串数组，列出要跳过的 provider id。条目会被 trim。默认 `[]`。

插件自己注册的 id 是 `hardware`、`memory`、`runtime`、`workers`、`computer-use`、`ui` 与
`context`。命名了未注册 provider 的条目无害。以这种方式被禁用的 provider 会被列入采样轮的
`skipped` 数组 —— 但只有在它本来会被注册时才会出现在 `skipped` 里；被 `disabledProviders`
过滤掉的 provider 根本不会被注册，因此也不会有采样轮记录。

## `providerOptions`

### `providerOptions.hardware`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `ignoreMetrics` | 规范指标名数组 | `[]` | 即使辅助程序上报了也必须被硬件 provider 丢弃的指标。非法名称会被 `resolveConfig` 静默过滤掉（`.filter(isCanonicalMetric)`）。 |
| `helperCommand` | 字符串数组 \| `null` | `null` | 命令与参数，**不经 shell** 执行。其 stdout 按 `name=value` / `name,value` 行解析并合并进样本。`null` 表示没有热遥测来源。 |
| `helperTimeoutMs` | number > 0 | `5000` | 辅助命令在被放弃前可运行的时长。超时会杀掉子进程并让样本降级。 |

辅助程序解析出的指标会被合并进样本，**不会**按硬件 provider 自己的指标列表过滤，因此一个辅助
程序也可以提供内存指标 —— 但 `ignoreMetrics` 会作用于辅助程序的输出，所以被忽略的指标在原生
路径与辅助路径上都会被丢弃。

### `providerOptions.memory`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `extraPids` | 非负整数数组 | `[]` | **只是一条 note，不是实现。** 非空时样本的 `note` 会写 `process tree RSS includes N configured extra pid(s)`；并不会真的把任何进程加进 RSS 求和。 |

内存 provider **没有自己的辅助选项**：`applyHealthScheduler` 把
`config.providerOptions.hardware.helperCommand` 与 `helperTimeoutMs` 传进内存 provider，因此两个
provider 运行同一条命令，各自保留它能识别的指标。

### `providerOptions.runtime`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `heartbeatFile` | string \| `null` | `null` | 宿主在每一个事件循环轮次触碰的文件。provider 读取其 mtime 并上报 `heartbeat_delay_ms = max(0, now - mtime - heartbeatExpectedMs)`。`null` 关闭该读数。已配置但不可读的文件会产生一条 note 且没有指标。 |
| `heartbeatExpectedMs` | number > 0 | `15000` | 期望的心跳节奏。 |

刚好准时的文件报告 `0`；停止被触碰的文件报告它的完整年龄，这正是让冻结的 UI 可见的方式。

### `providerOptions.computerUse`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `probeOnTick` | boolean | `false` | **被接受但被忽略。** 不存在 computer-use 探测；该 provider 由 stats 文件驱动。 |
| `probeTimeoutMs` | number > 0 | `2000` | **被接受但被忽略**，原因同上。 |

### `providerOptions.statsFile`

| 键 | 类型 | 默认 | 作用 |
| --- | --- | --- | --- |
| `paths` | 非空字符串数组 | `[]` | 要读取的文件，按顺序。**第一个可读的**胜出；不存在的路径被跳过。读取最多缓存 2 秒。 |
| `staleAfterMs` | number > 0 | `120000`（2 分） | 文件内容被拒绝、其 provider 报告 degraded 样本（detail 中给出文件年龄）的阈值。 |
| `commands` | `{ argv, timeoutMs? , format }` 数组 | `[]` | 由**全部四个** stats 支撑的 provider 运行的额外探测。见下文。 |

四个 stats 支撑的 provider（`workers`、`computer-use`、`ui`、`context`）共享**一个**
`StatsFileSource` 和**一份**命令列表。因为每个 provider 只从共享结果中复制属于自己 `provides`
列表的指标，一条命令可以同时打印多个分组的指标，每个 provider 各取所需。没有归属任何 stats 支撑
provider 的指标 —— 例如 `ipc_timeout_rate` —— 会被静默忽略，即使文件或命令正确上报了它；当它
来自文件时，它会出现在样本的 `unknownKeys` note 里。

## stats 文件格式

stats 文件是一份 JSON 文档。两种形状都被接受：

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

读取器强制执行的规则：

- 如果文档有一个对象值的 `metrics` 键，该对象就是载荷；否则文档本身就是。
- `timestamp`、`schemaVersion` 与 `source` 无论出现在哪里都会被跳过。
- 不是规范指标名的键会被收进 `unknownKeys`，并在样本的 `note` 中以
  `stats file contains non-canonical keys: …` 呈现。它**从不**被并入指标，因此拼写错误会显现
  出来，而不是什么都不做。
- 不是有限数的值会被忽略。
- 决定过期与否的是文件的 mtime，不是任何 `timestamp` 字段。
- 要么原子写入，要么完全不写：被截断的 JSON 文档解析失败，读取会落到 `paths` 中的下一个路径。
  如果没有任何路径能解析，detail 会列出所有尝试过的路径。

一个最小的写入器，按计划或由拥有这些数字的组件运行：

```powershell
# C:\dsh\telemetry\publish.ps1 —— 写入 UI provider 读取的 stats 文件
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

## 命令探测格式

命令探测是一个 `argv` 数组，由 `execFile` **不经 shell** 执行，`maxBuffer` 1 MiB，
`windowsHide: true`。其 stdout 逐行解析：

| 行 | 结果 |
| --- | --- |
| 空行，或以 `#` 开头 | 忽略 |
| `name=value` 或 `name,value` | 解析；`name` 必须匹配 `^[A-Za-z][A-Za-z0-9_]*$` 且必须是规范名 |
| 其他任何内容 | 静默忽略 |
| 规范名但值不是有限数 | 记入 `malformed` 并在样本 note 中报告 |

分隔符是 `=` 或 `,`，两侧可有可无空白。分隔符之后的内容整体交给 `Number()`，因此 `52 °C` 会
失败（malformed），而 `52.0` 与 ` 52 ` 会成功。

以非零状态退出、被超时杀掉、或无法启动的探测会产生 `error !== null`；调用方报告一个 degraded
样本，并保留它已经测到的东西。超时的错误消息是 `command probe timed out after <N> ms`。

### 在 Windows 上读取 GPU 温度

`nvidia-smi` 默认输出 CSV，也无法让它输出 `name=value`，因此探测是一个单行 PowerShell 包装器，
它运行 `nvidia-smi` 并打印规范行。这个做法在装有 NVIDIA GPU 的机器上验证过：
`nvidia-smi --query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader` 输出
`52, 4 %`。

```powershell
# C:\dsh\gpu-temp.ps1
# 为硬件 provider 打印规范指标行。
# 不涉及 shell：插件用下面的 argv 通过 execFile 运行它。
$raw = & nvidia-smi --query-gpu=temperature.gpu,utilization.gpu --format=csv,noheader 2>$null
if ($LASTEXITCODE -ne 0 -or -not $raw) { exit 1 }   # 非零退出 => 降级样本，而不是零
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

它恰好产出 provider 想要的那两行：

```text
gpu_temp_c=52
gpu_usage=0.04
```

注意事项与诚实的局限：

- `powershell` 必须在 `PATH` 上。`execFile` 在 Windows 上通过 `PATH`/`PATHEXT` 解析可执行
  文件，所以裸名字可用；如果不在 `PATH` 上，就用绝对路径
  （`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`）。
- 用非零退出表示“没有读数”是推荐做法。插件会把它变成 degraded 样本，压力模型将其评为
  `unknown` —— 永远不是 `0`。
- CPU 温度没有可移植来源。`Get-CimInstance -Namespace root/WMI -ClassName
  MSAcpi_ThermalZoneTemperature` 在固件暴露它时返回以开尔文的十分之一为单位的
  `CurrentTemperature`（`(x / 10) - 273.15` 得到摄氏度），但它在桌面主板上经常以“不支持”失败，
  本文档编写所用的机器上验证即为失败。芯片组专用工具才是现实来源。
- 辅助程序**以你的权限**运行。在你自己的脚本上用 `-ExecutionPolicy Bypass` 没问题；把
  `helperCommand` 指向下载来的脚本则是另一个问题，不是插件能解决的。

## 添加自定义传感器

1. **如果该物理量已有规范名，就直接用它。** 一个新探测只要输出 `gpu_temp_c=…`，就会被现有的热
   band 打分，无需任何配置变更。这是预期路径，覆盖几乎所有情况。
2. **如果该物理量是某个已有指标的新*来源*，但你不希望它被打分**，把名字加进
   `providerOptions.hardware.ignoreMetrics`，或删掉 `metrics` 中该指标的 `band`，让它只贡献趋势
   项。
3. **如果该物理量确实是新的**，必须在 `src/types/metrics.ts` 中扩展规范注册表：把名字加进
   `CanonicalMetric` 联合类型，往 `METRICS` 加描述符（单位、极性、分组、可选的
   `hardMin`/`hardMax`、描述），如果它应该被打分就往 `DEFAULT_METRIC_CONFIG` 加默认条目，并把
   它加进 `src/core/pressure.ts` 的 `METRIC_DIMENSION` **以及**某个 provider 的 `provides`
   列表。漏掉后两项，该指标会被采集但被压力模型静默忽略 —— 这是一个合理的选择，但它应当是刻意
   的选择。
4. **重新构建并重新验证。** `npm run build`，然后 `npm test`。`tests/normalization.test.js`
   断言每个规范名都有描述符、注册表键有序且唯一、词表至少 40 项。往 provider 的 `provides`
   列表中漏加某个指标不会被测试捕获。

provider 不得自创指标名。`normalizeSample` 会以 `not_canonical` violation 与一条警告拒绝未知键，
因此不受支持的名字会被看见，而不是被静默丢弃。

## 被拒绝的文档及其消息

`ConfigError` 消息按 `health-scheduler config: <path> <message>` 构造，因此它会指明确切的叶子。
一部分示例：

| 文档 | 消息片段 |
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

命令探测上的 `format` 总是被强制为 `'name-value'`；不存在第二种格式，你写的值会被忽略而不是被
校验。
