# 验收

[English](acceptance.md) | 中文

本文档把设计稿的验收标准与关键场景映射到真正验证它们的测试上。下面每个测试名都是真实的，且按提交
状态测试套件全部通过：

```sh
node --test tests/*.test.js
# tests 148 / suites 27 / pass 148 / fail 0
```

测试文件：

| 文件 | 套件 | 覆盖内容 |
| --- | --- | --- |
| `tests/normalization.test.js` | `canonical metric registry`、`normalizeSample`、`band scoring`、`sustain gate` | 词表、物理边界、爬升、持续时间门。 |
| `tests/rolling.test.js` | `RollingStore`、`daily summaries`、`TrendAnalyzer` | 窗口统计、保留下限、band 计时、每日汇总、斜率与 R² 门槛、投影、格式化。 |
| `tests/policy.test.js` | `action ladder`、`anti-flapping`、`restart gate`、`machine states` | 阈值、滞回、防抖、驻留、冷却、重启门禁、状态机。 |
| `tests/maintenance.test.js` | `wall-clock parsing`、`maintenance picture`、`safe points` | 窗口算术、全部六个阶段、推迟账本输入、安全点折叠。 |
| `tests/scenarios.test.js` | `synthetic scenarios`、`synthetic scenario invariants`、`scenario rig self-checks` | 六个设计场景端到端跑真实的调度器，外加不变式与 rig 自检。 |
| `tests/plugin.test.js` | `plugin exports`、`applyHealthScheduler`、`model-facing tools`、`presentation helpers`、`external telemetry seams` | Cordis 契约、那条「不导出任何可以重启或杀进程的东西」的检查、设置注册、三个工具、报告渲染器，以及 stats 文件 / 命令探测接缝。 |
| `tests/scheduler.test.js` | `ProviderRegistry`、`unavailable adapters`、`HealthScheduler`、`DecisionLog`、`scheduler clock discipline` | 熔断与指数退避、不可用适配器、tick 流水线与冷却对尝试次数的约束、日志轮转与回读、tick 节奏。 |

测试夹具：`tests/helpers/rig.js`（带可注入时钟、脚本化 provider、记录型适配器与脚本化安全点的
`ScenarioRig`）以及 `tests/helpers/drive.js`（共享的动作、状态与理由词表，以及 `drive()` 循环）。
`tests/plugin.test.js` 与 `tests/scheduler.test.js` 直接构造假的 harness context，而不经过 rig。

## 验收标准

设计稿第 27 节把这些列成勾选框。源文档中实际有 **18** 个勾选框（本文档对应的任务书称之为 17 条
标准）；下面 18 条全部映射。“由谁验证”一列写的是真实测试。

| # | 标准 | 由谁验证 | 自动？ |
| --- | --- | --- | --- |
| 1 | 不含任何 `taskkill` / reboot 直接执行逻辑。 | 没有测试断言。靠检视验证：唯一的 `execFile` 调用是 `runCommandProbe`，它运行用户配置的遥测探测；`src/` 中不存在任何杀进程或重启 API。 | **手动** |
| 2 | Restart 插件完全可替换。 | 没有测试断言。靠结构验证：`RestartAdapter` 是双方法接口，`isRestartAdapter` 是对 `ctx.healthScheduler` 的结构检查，`applyHealthScheduler` 接受注入的 `restart` 适配器。rig 里的 `RecordingRestartAdapter` **就是**一个即插即用的替换品，而每个场景测试都在用它。 | **手动**（设计层面） |
| 3 | Provider 全部可独立失败。 | `records provider failures without stopping the loop` | 是 |
| 4 | 单一 Provider 挂掉不影响整体运行。 | 部分：`records provider failures without stopping the loop` 断言四拍中一次失败且拍数不受影响；`keeps ticking through a restart adapter that throws, without a request storm` 断言循环能挺过抛异常的适配器。但没有测试在**整个**退避窗口内让某个 provider 持续失败、并断言其他 provider 仍在被采样。 | **部分** |
| 5 | 没有 telemetry 时标记 unknown，而不是 healthy。 | `returns unknown, not zero, for a missing value`；`stays unknown for a missing value regardless of duration`；`returns null statistics for a metric with no data instead of zero`；`marks the state DEGRADED when no telemetry is available at all`；`omits absent metrics instead of inventing zero` | 是 |
| 6 | 瞬时高温不会触发重启。 | `a transient GPU spike never reaches pressure at all`；以及 `scores zero while the condition has not been held long enough` | 是 |
| 7 | 长期趋势可提高压力。 | `detects a memory leak as a worsening trend`；`projects when a leak reaches a ceiling`；`a four-hour RSS leak becomes pressure without any OOM` | 是 |
| 8 | 内存泄漏趋势可被识别。 | `detects a memory leak as a worsening trend`；`a four-hour RSS leak becomes pressure without any OOM` | 是 |
| 9 | worker 异常率可进入 pressure。 | `worker retry storms reach pressure through the worker dimension` | 是 |
| 10 | Computer Use 卡顿可进入 pressure。 | `Computer Use degradation raises interactive pressure before anything restarts`；`a frozen UI heartbeat reaches pressure and is reported as a driver` | 是 |
| 11 | 定时维护使用 window，而非硬时间点。 | `is outside the window before it opens`；`is before_target inside the window but ahead of the target`；`is at_target exactly on the target instant`；`is deferred while the deferral budget lasts, then overdue`；`never allows a request when the configuration forbids one` | 是 |
| 12 | throttle 优先于 restart。 | `a sustained heat soak raises thermal pressure and throttles`；`holds a restart request until the maintenance window opens` | 是 |
| 13 | restart 优先 app 而不是 system。 | `escalates to a system reboot only above the top threshold`；`maps actions onto cooldown buckets and durations`。阶梯本身在 `action ladder` 中逐级断言。 | 是 |
| 14 | system reboot 只用于升级路径。 | 部分：第 4 级要求压力 ≥ 它自己的 `enter`，而该值严格高于第 3 级的，且 `gateRestart` 会追加 `system_reboot_requires_restart_adapter`。但理由字符串 `escalation_requested_at_maximum_pressure` 是无条件附加的 —— **没有**升级计数器，也没有重启结果的反馈回路，因此引擎并没有真的验证此前有一次应用重启失败过。 | **部分** |
| 15 | 有 hysteresis，避免状态抖动。 | `holds the active action while pressure sits inside the hysteresis band`；`does not oscillate around a threshold` | 是 |
| 16 | 每次决策可解释。 | `produces one explainable reason per applied action`；`never emits an action above the pressure that justifies it` | 是 |
| 17 | 长时间运行无 decision storm。 | `keeps ticking through a restart adapter that throws, without a request storm`（30 分钟、120 次评估，适配器调用被限制在 ≤ 3 次）。没有 6 小时 / 12 小时 / 24 小时的长跑测试。 | **部分** |
| 18 | 卸载本插件不影响 DS-Hns 主程序运行。 | 没有断言，也无法从插件内部断言。相关证据是结构性的：`tryResolveConfig` 使得坏的用户文档无法让启动失败，provider、适配器、安全点与日志失败全部被容纳，工具注册失败按工具逐个捕获，`ctx.effect` 在 dispose 时停止定时器。这是“容纳”，不是证明 —— 如果真的出现 provider id 重复，`upstream.registerProvider` 会向外传播。 | **手动** |

设计稿的清单有 18 个勾选框，本文档按 1–18 编号；本任务书称之为 17 条标准。无论如何，其中五条只有
部分覆盖或完全没有自动覆盖。

## 六个关键场景

设计稿第 26 节。每个场景都用可注入时钟、端到端地跑真实的 `HealthScheduler` ——
providers → normalization → rolling windows → trend → pressure → policy。

### 场景 1 —— 瞬时高温

> GPU 90 °C 持续 30 秒。期望：不重启。

测试：**`a transient GPU spike never reaches pressure at all`**

先跑 2 分钟的 `HEALTHY_BASELINE`，然后 `gpu_temp_c: 90` 持续 30 秒、每 2 秒采样一次，断言
`pressure === 0`、`state === 'HEALTHY'`，且所有记录到的动作都是 `NO_ACTION`。机制是：
`gpu_temp_c` 在 90 °C 时的原始分是 86，但它的 `sustainMs` 是 60 000，因此持续 30 秒会被门限为 0。

### 场景 2 —— 持续高温

> GPU 88 °C 持续 20 分钟。期望：`THROTTLE`；若无法恢复，则 `REQUEST_APP_RESTART`。

测试：**`a sustained heat soak raises thermal pressure and throttles`**

5 分钟基线，然后 `gpu_temp_c: 88`、`cpu_temp_c: 84`、`gpu_usage: 0.95`、`cpu_usage: 0.9`、
`thermal_throttle: 0.05` 持续 20 分钟、每 15 秒一拍。断言热维度得分高于 55、压力大于 0、动作集合
包含 `PAUSE_NEW_WORK` 或 `THROTTLE` —— 并且特别断言
`restart.applicationRequests.length === 0`，因为默认维护窗口是关闭的。

“若无法恢复”那一半由 **`holds a restart request until the maintenance window opens`** 覆盖：它
断言在压力 85 时原始候选是 `REQUEST_APP_RESTART`，而生效动作是 `PAUSE_NEW_WORK`、状态是
`MAINTENANCE_PENDING`。

相关：**`thermal throttle plus long duration is extreme, and says so`** 跑 25 分钟的 93 °C /
92 °C / `thermal_throttle: 0.6` / `power_limit_hit: 0.7`，断言热维度达到 `critical` 等级、
`thermal_throttle` 自身读作 `critical`，并且报告了匹配的 driver。

### 场景 3 —— 内存缓慢泄漏

> RAM 占用持续上升 4 小时。期望：趋势压力增加；在维护窗口内安全重启。

测试：**`a four-hour RSS leak becomes pressure without any OOM`**

在 32 GiB 中还有 20 GiB 可用、`ram_used_ratio: 0.62` 的机器上跑 240 分钟的干净 1.2 GB/h RSS
爬升。断言内存维度得分高于 40、`process_rss_bytes` 以恶化趋势出现、报告了 `memory` driver，以及
总压力高于 35 —— 这些都不需要真的发生过 OOM。

“在维护窗口内安全重启”那一半由
**`requests an application restart inside an open window with a confirmed safe point`** 与
**`blocks a restart when the safe point is unknown, because unknown is not yes`** 覆盖。

### 场景 4 —— 任务繁忙但健康

> 压力低、维护目标时间已到、有关键任务在跑。期望：推迟。

测试：**`is deferred while the deferral budget lasts, then overdue`** 与
**`is at_target exactly on the target instant`** 直接构造画面；
**`requests an application restart inside an open window with a confirmed safe point`** 与
**`blocks a restart when the safe point is unsafe`** 展示策略后果：压力 85 时的
`git_commit_in_progress` 产出 `PAUSE_NEW_WORK`，理由为 `safe_point_unsafe` 与
`safe_point_reason_git_commit_in_progress`，状态机记录 `MAINTENANCE_PENDING`。

### 场景 5 —— 运行明显劣化

> UI 延迟上升、worker 超时上升、内存斜率上升。期望：维护优先级迅速上升。

测试：**`a frozen UI heartbeat reaches pressure and is reported as a driver`**（UI 为
`render_latency_ms: 2600`、`main_window_heartbeat_ms: 12000`、`blank_frame_rate: 0.25`、
`frontend_error_rate: 0.3` → 等级 `critical` 且带匹配 driver）；
**`worker retry storms reach pressure through the worker dimension`**（`timeout_rate: 0.35`、
`failure_rate: 0.28`、`retry_rate: 0.7`、`task_latency_ms: 220000`、`abnormal_exit_rate: 0.25`
→ worker 等级 `critical` 且带 `worker_*` driver）；
**`Computer Use degradation raises interactive pressure before anything restarts`**（设计稿的
0.5 秒 → 1.2 秒 → 2.8 秒 → 5 秒 截图爬升 → 交互维度得分高于 50 且趋势恶化）。

### 场景 6 —— Restart 插件失效

> 期望：Health Scheduler 不崩溃。

测试：**`keeps ticking through a restart adapter that throws, without a request storm`**
（一台永久危重的机器以 15 秒一拍跑 30 分钟，适配器对每次请求都抛异常：循环存活，能力仍然读作
`available`，出现 `not applied` 警告，适配器总尝试次数在 1 到 3 之间）；
**`blocks a restart when the restart capability is unavailable`**（能力为 `unavailable` →
生效动作 `PAUSE_NEW_WORK`，理由 `restart_capability_unavailable`）。

`UnavailableRestartAdapter` —— 即 `dsh-restart` 缺席时使用的适配器 —— 被每一个未覆盖它的策略
测试间接覆盖，也被 `restartCapability: 'unavailable'` 用例直接覆盖。

## 其他被断言的内容

### 指标词表

| 测试 | 钉住了什么 |
| --- | --- |
| `exposes a descriptor for every metric name` | 每个规范名都有描述符且 `name` 匹配、`description` 非空；词表至少 40 项。 |
| `keeps the registry keys sorted and unique` | `CANONICAL_METRICS` 有序且无重复，因此快照与 diff 稳定。 |
| `rejects names outside the vocabulary` | `gpu_temp` 不是指标；`__proto__` 与 `toString` 也不是。 |
| `declares hard bounds only where physics justifies them` | `cpu_temp_c.hardMax === 130`、`ram_used_ratio.hardMax === 1`、`process_rss_bytes.hardMax === undefined`、`recovery_rate.polarity === 'lower-is-worse'`、`ram_available_bytes.polarity === 'lower-is-worse'`。 |

### 规范化

| 测试 | 钉住了什么 |
| --- | --- |
| `keeps measured values and reports nothing` | 干净样本产出的指标与送入的完全一致，且没有 violation。 |
| `omits absent metrics instead of inventing zero` | 空包保持为空；键不存在。 |
| `rejects non-finite and non-numeric readings` | `NaN`、`Infinity` 与 `'0.5'` 产生 `not_finite` / `not_a_number` 并被丢弃。 |
| `rejects values outside the physical range` | `cpu_temp_c: 4000` 与 `cpu_usage: -1` 产生 `above_hard_max` / `below_hard_min`。 |
| `clamps a percentage sent where a ratio is canonical, and says so` | `cpu_usage: 1.2` 变成 `1`，并附一条 `clamped` violation。 |
| `sorts output by metric name for stable snapshots` | 输出键顺序确定。 |
| `parses timestamps and rejects nonsense` | `parseSampleTime` 对 `'not-a-date'` 与 `''` 返回 `null`。 |

### Band 算术

| 测试 | 钉住了什么 |
| --- | --- |
| `scores zero below the warn endpoint and 100 at critical` | `scoreMetric('gpu_temp_c', 70/78/92/99, {78, 92})` → `0/0/100/100`。 |
| `ramps linearly in between` | `85 → 50`、`81 → 21`。 |
| `accepts a band written in either order` | `recovery_rate` 在 0.55 时，`{0.8, 0.3}` 与 `{0.3, 0.8}` 都得 50；`rampEndpoints` 对 `lower-is-worse` 返回 `[0.8, 0.3]`，对 `higher-is-worse` 返回 `[0.8, 0.96]`。 |
| `returns unknown, not zero, for a missing value` | `scoreMetric(…, null, …) === null`；`levelOf(null) === 'unknown'`。 |
| `maps scores onto the documented level bands` | `LEVEL_BOUNDS.moderate/high/critical` 边界。 |
| `clamps out-of-range values into the range` | 两个方向的 `clamp`。 |

### 持续条件

| 测试 | 钉住了什么 |
| --- | --- |
| `scores zero while the condition has not been held long enough` | 60 秒门中的 5 秒：`score: 0`、`rawScore: 71`、`gated: true`。 |
| `scores the real value once the condition has been held` | 60 秒时：`score: 71`、`gated: false`。 |
| `does not gate when no sustain time is configured` | `sustainMs: 0` 立即给分。 |
| `stays unknown for a missing value regardless of duration` | 输入 `null` 输出 `null`，即使过了 10 分钟。 |
| `tracks consecutive time inside a declared band and resets on band change` | `declareBand` 进入时返回 0，随后累积，并在 band 切换与离开所有 band 时重置。 |

### 滚动窗口与趋势

| 测试 | 钉住了什么 |
| --- | --- |
| `computes mean, percentiles and extremes over a window` | 100 个点：`min 60`、`max 79.8`、`mean ≈ 69.9`、`p95 ≥ 78`，`latest`/`earliest` 正确。 |
| `returns null statistics for a metric with no data instead of zero` | `count: 0` 且每个统计量为 `null`。 |
| `raises the raw floor to the longest statistics window when the floor is shorter` | `rawMs: 5 分` 配 30 分钟窗口变成 `30 分`；500 个点中存活 31 个。 |
| `honours an explicitly longer raw floor than the longest window` | `rawMs: 12 时` 保留全部 700 分钟。 |
| `keeps aggregate buckets far beyond the raw horizon` | 24 小时的 5 分钟写入后仍有 ≥ 200 个桶。 |
| `reports statistics for every configured window` | 每个窗口一个 `WindowStats`，计数单调不减。 |
| `bounds memory: raw points stay proportional to the retention horizon, not to uptime` | 以 1 Hz 写 20 000 次、30 分钟跨度，剩下 ≤ 1 850 个点。 |
| `detects a memory leak as a worsening trend` | 4 小时 +200 MB/h：`direction === 'rising'`、`isWorsening`、`R² > 0.99`，斜率误差在 5 MB/h 内。 |
| `does not call a rising temperature a problem when the fit is noise` | 噪声序列 `isWorsening === false` 且 `R² < 0.5`。 |
| `does not treat a falling temperature as worsening` | `higher-is-worse` 指标：`direction === 'falling'`、`isWorsening === false`。 |
| `treats a falling recovery_rate as worsening` | `lower-is-worse` 指标：`direction === 'falling'`、`isWorsening === true`。 |
| `refuses to report a slope before the minimum observation span` | 5 秒内 5 个样本 → `direction: 'unknown'`、`slopePerHour: null`，摘要匹配 `/insufficient observation/`。 |
| `projects when a leak reaches a ceiling` | 500 MB/h 朝 8 GB 上限，投影落在 2 到 5 小时之间。 |
| `formats slopes in the metric own unit` | `formatBytes(1.5e9) === '1.40 GB'`、`formatSlopePerHour('gpu_temp_c', 12) === '12.00 °C/h'`。 |
| `returns only worsening trends, worst fit first` | 双指标存储中只返回 `process_rss_bytes`。 |

### 动作阶梯与防抖

| 测试 | 钉住了什么 |
| --- | --- |
| `does nothing below the throttle threshold` | 压力 40 → `NO_ACTION`、`HEALTHY`。 |
| `throttles at the throttle enter threshold` | 压力 55 → `THROTTLE`、`THROTTLED`，理由 `pressure_55_gte_throttle_55`。 |
| `pauses new work at the pause threshold` | 压力 72 → `PAUSE_NEW_WORK`、`PAUSED`。 |
| `holds a restart request until the maintenance window opens` | 压力 85、窗口关闭 → 候选 `REQUEST_APP_RESTART`、生效 `PAUSE_NEW_WORK`、状态 `MAINTENANCE_PENDING`、理由 `maintenance_window_closed`。 |
| `requests an application restart inside an open window with a confirmed safe point` | 窗口开启 + 安全点 → `REQUEST_APP_RESTART`，理由 `safe_point_confirmed`。 |
| `escalates to a system reboot only above the top threshold` | 压力 96 且状态已升级 → `REQUEST_SYSTEM_REBOOT`。 |
| `holds the active action while pressure sits inside the hysteresis band` | 60 → 节流；50 保持且 `hysteresisHeld === true`；40 释放为 `NO_ACTION` / `HEALTHY`。 |
| `does not oscillate around a threshold` | 序列 `56, 54, 56, 54, …` 在全部八次评估中都产出 `THROTTLE`。 |
| `debounces a high-risk action across evaluations` | `debounceEvaluations: 3`：前两次评估是 `NO_ACTION` 并带 `debounce_` 理由；第三次才动作。 |
| `holds a transition to a calmer level until the dwell time elapses` | 第 15 秒的恢复被保持，理由 `dwell_suppressed_transition`；到 130 秒时通过。 |
| `never delays the first crossing out of NO_ACTION` | 驻留 10 分钟时，一次全新的压力 60 跨越立即节流。 |
| `cooldown suppresses a repeat but not a recovery` | 桶内重复保持生效，`cooldownActive === true` 且 kind 为 `throttle`；压力 20 的恢复产出 `NO_ACTION` / `HEALTHY`。 |
| `maps actions onto cooldown buckets and durations` | `THROTTLE`/`PAUSE_NEW_WORK` → `throttle`；`REQUEST_APP_RESTART` → `maintenance`；`REQUEST_SYSTEM_REBOOT` → `escalation`；时长读自配置。 |

### 重启门禁

| 测试 | 钉住了什么 |
| --- | --- |
| `blocks a restart when the restart capability is unavailable` | 生效 `PAUSE_NEW_WORK`，理由 `restart_capability_unavailable`。 |
| `blocks a restart when the safe point is unsafe` | 理由 `safe_point_unsafe` 与 `safe_point_reason_git_commit_in_progress`。 |
| `blocks a restart when the safe point is unknown, because unknown is not yes` | `safe: null` 时理由 `safe_point_unknown`。 |
| `blocks a restart before the target time even inside the window` | 理由 `maintenance_before_target_time`，状态 `MAINTENANCE_PENDING`。 |
| `lets an urgent override escalate past the window` | 在 `urgent_override` + 不安全安全点下：第 4 级通过，同时带 `urgent_override_active` 与 `escalation_overrides_safe_point`。 |
| `does not delay a critical escalation behind a debounce by accident` | 两次危重评估中的第一次被保持；第二次升级。 |

### 插件表面（`tests/plugin.test.js`）

| 测试 | 钉住了什么 |
| --- | --- |
| `exposes the Cordis plugin contract` | `name`、`inject` 与 `apply` 齐备且形状符合加载器预期。 |
| `exposes the documented public API surface` | README 与本文档承诺的导出就是实际存在的导出。 |
| `never exports anything that could restart or kill a process` | 标准 1 的自动化一半：包没有任何导出成员是子进程、kill、reboot 或 shutdown 原语。 |
| `registers the three tools and starts monitoring` | `applyHealthScheduler` 返回三个工具名与一个运行中的调度器。 |
| `registers its settings namespace with the resolved config as the base layer` | `health-scheduler` 命名空间以 `base: config` 与 `applies: 'live'` 注册。 |
| `runs without a tools service and says so` | 缺少 `tools` 服务只降级为一条警告，而不是失败。 |
| `runs without a settings service and says so` | `settings` 同理。 |
| `rejects a bad configuration loudly but keeps running on the default preset` | 标准 18 的容纳能力：`ConfigError` 被记录，并改用 `balanced`。 |
| `starts and stops the loop through apply and dispose` | dispose 时定时器被释放。 |
| `does not start when the configuration disables it` | `enabled: false` 会加载插件，但既不采样也不启动循环。 |
| `uses an unavailable restart adapter when dsh-restart is not installed` | 标准 2 的回退路径与场景 6。 |
| `writes the decision log when a state directory is provided` | 有可写目录时审计轨迹会落盘。 |
| `health_status returns a readable report and never claims unknown is healthy` | 标准 5 在模型视角下的表现。 |
| `health_status supports its sections` | `full` / `pressure` / `maintenance` / `providers`。 |
| `health_history returns window statistics as JSON` | `health_history` 的载荷形状。 |
| `health_history rejects a non-canonical metric with a helpful error` | 错误会指出未知指标并列出合法名称。 |
| `health_policy explains the ladder, the config and the audit trail` | 三种 `action` 模式。 |
| `tool definitions advertise a bounded timeout and a string schema` | 每个工具都声明超时，而不会把一轮对话挂死。 |
| `takes a first tick on demand when no snapshot exists yet` | 第一次计划 tick 之前的工具调用仍然有答案。 |
| `renders a compact JSON payload with snake_case keys` | `metricsSnapshot()` 的键契约。 |
| `formats a metric row for a table` | `renderMetricRow` 渲染 `unknown`，而不是占位数字。 |
| `renders a report that mentions every section` | 人类可读报告不会静默丢掉任何一节。 |
| `parses name=value and name,value command output and ignores unknown names` | 命令探测格式，包括非规范名会被丢弃。 |
| `accepts both a wrapped stats document and a bare metric object` | 两种 stats 文件形状。 |
| `reports an unconfigured stats source as unknown, never as zero` | 标准 5 在外部接缝上的表现。 |
| `reports a missing stats file with a reason` | detail 会列出查找过的路径。 |
| `treats a stale stats file as degraded` | `staleAfterMs` 会拒绝过期内容，而不是给它打分。 |
| `reads a stats file into the stats-backed providers` | 四个 stats 支撑的 provider 按各自的 `provides` 列表拆分同一个文件。 |
| `reports a failing helper command as a degraded sample rather than an error` | 以非零状态退出的辅助程序只会让样本降级，不会抛异常。 |

### 调度器与注册表（`tests/scheduler.test.js`）

| 测试 | 钉住了什么 |
| --- | --- |
| `rejects a duplicate provider id` | 注册有幂等守卫，两个 provider 不能争抢同一个 id。 |
| `contains a throwing provider and keeps the others` | 标准 3 与标准 4。 |
| `applies an exponential backoff after the failure limit and retries later` | 熔断器：先容忍失败，然后进入跳过窗口，随后恢复。 |
| `honours the disabled list and per-provider enable flag without failing` | `disabledProviders` 与 `enabled: false`。 |
| `notifies failure listeners without letting one break sampling` | 抛异常的观察者不能中断采样轮。 |
| `report unavailable and refuse without throwing` | `UnavailableRestartAdapter` 与 `UnavailableWorkerControlAdapter`。 |
| `builds audit outcomes from adapter results` | `outcomeForAction`。 |
| `produces a snapshot with unknown dimensions when nothing is registered` | 零 provider 时的标准 5：每个维度都是 unknown，压力是 `null` 而不是 `0`。 |
| `records metrics, computes pressure and keeps coverage honest` | coverage 数值与实际存在的遥测相符。 |
| `applies a throttle through the worker-control adapter and releases it on recovery` | 标准 12 的机制，包括释放。 |
| `refuses to guess a concurrency target when none is configured or derivable` | `throttleLimit` 返回 `null`，而不是编造一个上限。 |
| `survives an unavailable worker-control adapter` | 缓解手段降级；监控继续。 |
| `records a decision for every applied action and explains it` | 标准 16 在调度器层面的表现。 |
| `does not emit a decision storm over a long run` | 标准 17 在调度器层面的表现。 |
| `starts and stops the periodic loop idempotently` | 两次 `start()` 仍是一个循环；`stop()` 安全。 |
| `does not sample at all when disabled` | `enabled: false` 会让 tick 短路。 |
| `reconfigures live without losing history` | `reconfigure` 保留存储与策略状态。 |
| `exposes per-window history for a metric` | `windowsFor()` 为每个已配置窗口返回一项。 |
| `ingests a sample directly and reports normalization violations` | `ingest()` 接缝及其 violation 上报。 |
| `contains a throwing event listener` | 坏的订阅者不能中断循环。 |
| `uses a registered safe point to gate the maintenance request` | 安全点经由真实调度器抵达策略层，而不只是手工构造的输入。 |
| `keeps a bounded in-memory ring`、`writes and reads back a JSONL log with a schema version`、`tolerates a truncated trailing line`、`never throws when the log directory cannot be written`、`rotates the file once it exceeds the size budget` | `DecisionLog` 的完整契约，包括失败路径。 |
| `never samples faster than the configured interval when running` | 循环遵守 `sampling.intervalMs`。 |
| `keeps the last tick instant` | `lastTickMs` 跟随注入的时钟。 |
| `reports uptime-derived time pressure through the runtime provider` | uptime 爬升在真实流水线中由 `uptime_seconds` 供数，而不只是在单元测试里。 |

### 状态机

| 测试 | 钉住了什么 |
| --- | --- |
| `walks HEALTHY -> DEGRADED -> THROTTLED -> HEALTHY` | 压力 50 → `DEGRADED`（高于退出带、低于进入带）；60 → `THROTTLED`；10 → `HEALTHY`。 |
| `marks the state DEGRADED when no telemetry is available at all` | `pressure: null` → `DEGRADED`。 |
| `reaches SAFE_MODE only after a system reboot was requested` | 上一个状态为 `REQUEST_SYSTEM_REBOOT` 且压力已回落 → `SAFE_MODE`。 |

### 维护与安全点

| 测试 | 钉住了什么 |
| --- | --- |
| `parses valid times and rejects everything else` | 接受 `00:00`、`04:00`、`23:59`；拒绝 `24:00`、`4:00`、`04:60`、`nope`。 |
| `finds the previous and next occurrence of a wall clock time` | `now` 恰好等于目标时的边界行为。 |
| `tolerates a window that wraps past midnight` | `23:00`–`02:00` 包含 `23:30` 与 `01:30`，但不含 `12:00`。 |
| `formats durations for humans and evidence strings` | `90 秒 → '1m 30s'`、`3 时 5 分 → '3h 5m'`、`0 → '0s'`、`04:05`。 |
| `reports disabled when scheduled maintenance is off` | 阶段 `outside_window`、`nextTargetAt: null`，摘要匹配 `/disabled/`。 |
| `is outside the window before it opens` | 02:00 → `outside_window`。 |
| `is before_target inside the window but ahead of the target` | 03:45 → `before_target`、`windowClosesInMs === 75 分`，不允许请求。 |
| `is at_target exactly on the target instant` | 04:00 → `at_target`，允许请求。 |
| `is deferred while the deferral budget lasts, then overdue` | 04:10 → `deferred`（600 000 ms）；04:40 → `overdue` 且带 `max defer exhausted`；两者都允许请求。 |
| `takes the urgent override outside the window` | 14:00 压力 93 → `urgent_override`；91 → `outside_window`。 |
| `never allows a request when the configuration forbids one` | `allowAppRestart: false` 在压力 99 时也阻止请求。 |
| `resolves the window across a spring-forward style day boundary` | 目标在四个不同日期（含跨月）上都是本地 04:00，证明算术基于本地日历字段而不是固定偏移。 |
| `reports unknown, not safe, when nothing is registered` | `safe: null`、`reason: 'no_safe_point_source'`、`estimated_state: 'unknown'`。 |
| `folds sources worst-first` | 全部安全 → `true`；一个不安全 → `false` 且带该源的 reason；一个沉默 → `null`。 |
| `contains a throwing source and a hanging source` | `safe_point_source_failed` 与 `safe_point_timeout`，两者都在单源预算后贡献 `unknown`。 |
| `unregisters through the disposer` | 移除唯一来源后注册表回到 `safe: null`。 |

### 场景不变式与 rig 自检

| 测试 | 钉住了什么 |
| --- | --- |
| `never emits an action above the pressure that justifies it` | 把 `gpu_temp_c` 扫过 40 / 70 / 82 / 86 / 91 / 95，每条记录到的动作要么达到或超过其 band 的 `exit`，要么达到或超过其 `enter`，要么由 `hysteresis` 理由显式辩护。这是最廉价地捕获阶梯回归的不变式。 |
| `produces one explainable reason per applied action` | 每条记录都有非空理由列表、没有空理由、至少一个来自允许集合的机器可读前缀、一个 `pressure_` 理由（除非由滞回辩护）、非空的结果 detail 以及有限的 coverage。 |
| `drives the same number of ticks it was asked for` | rig 的时钟与调度器的 `lastTickMs` 一致。 |
| `records provider failures without stopping the loop` | 一次脚本化失败产生 `totalFailures: 1`、`totalSuccesses: 3` 与四份快照。 |
| `keeps ticking through a restart adapter that throws, without a request storm` | 见场景 6。 |

## 自动验证 vs 真机验证

| 领域 | 自动 | 需要真机 |
| --- | --- | --- |
| 指标词表、边界、爬升、持续时间门 | 是 | — |
| 畸形读数的规范化 | 是 | — |
| 滚动窗口、保留下限、内存上限 | 是 | — |
| 趋势检测、R² 门槛、极性、投影 | 是 | — |
| 压力模型、维度混合、coverage 重新归一化 | 是（通过场景 rig 与策略测试） | — |
| 动作阶梯、滞回、防抖、驻留、冷却 | 是 | — |
| 重启门禁与安全点折叠 | 是 | — |
| 维护阶段与墙钟算术 | 是 | — |
| 审计理由与结果 | 是 | — |
| 从 `os.cpus()` 测量 `cpu_usage` | 否 —— rig 与假环境会脚本化它 | 是。差分在某台机器上是否合理是真机问题。 |
| 从 `process.getActiveResourcesInfo()` 取 `handle_count` | 否 | 是。该代理只在真实运行时上才有意义。 |
| 从 `os` 取 `ram_*` 与 `process_rss_bytes` | 否 | 是。 |
| 配置的辅助命令产出可解析的行 | **是** —— `parses name=value and name,value command output and ignores unknown names` 与 `reports a failing helper command as a degraded sample rather than an error` | 是，对 `nvidia-smi` 这类真实厂商工具、在真实硬件上。 |
| stats 文件格式 | **是** —— `accepts both a wrapped stats document and a bare metric object`、`reports a missing stats file with a reason`、`treats a stale stats file as degraded`、`reads a stats file into the stats-backed providers` | 是，对真实集成在真实时序下写出的文件。 |
| 心跳文件 mtime 跟随活跃事件循环 | 否 | 是。 |
| 任何真实重启请求抵达 `dsh-restart` | 否 | 是。仓库里没有 `dsh-restart` 适配器。 |
| worker-control 真正改变并发 | 否 | 是。测试中没有绑定任何 harness worker-control 服务。 |
| 真实 profile 启动并加载 bundle patch | 否 | 是。对真实 profile 跑 `dsh --profile web --dump-config` 就是这个检查。 |
| 卸载后 DS-Hns 不受影响 | 否 | 是。 |
| 6 小时 / 12 小时合成与 24 小时 soak | 否 —— 长跑测试层未实现 | 是，且合成层本可以自动化 |

## 已知覆盖缺口

如实陈述，以便维护者决定先补哪个。上一版本文档中的若干缺口已经补上，列在本节末尾。

1. **没有长跑测试层。** 标准 17 只验证了 30 分钟的场景时间，而不是 6 或 12 小时。用现有 rig 跑
   6 小时合成很便宜（时钟是注入的，所以只是一次 tick 循环），并且会远更有说服力地支撑“无决策
   风暴”这一主张。
2. **没有测试 `normalizeSample` 的硬边界对齐。** `1e-9` 相对容差路径（刚好在边界内的值被对齐而
   不是被拒绝）没有被断言。
3. **没有测试 `resolveConfig` 的拒绝消息。** 校验规则被大量执行（每个测试都调用
   `resolveConfig`，`verify:artifacts` 也断言了两处拒绝），但确切的 `ConfigError` 文本没有被
   断言。configuration 文档里那张消息表目前是文档，还不是契约。
4. **没有测试设置的 *watch* 路径。** 注册被断言（
   `registers its settings namespace with the resolved config as the base layer`），调度器的实时
   重配置也被断言（`reconfigures live without losing history`），但把两者连起来的
   `scope.watch` 回调没有被端到端驱动。
5. **标准 2 没有自动化。** 没有任何东西断言可以替换进任意 `RestartAdapter` 且决策路径行为一致。
   rig 里已有的记录型适配器让这成为一个小测试。
6. **没有针对 stats 文件读取器的对抗性测试。** 符号链接路径、在 `existsSync` 与 `readFileSync`
   之间被替换的路径，以及超大文件在 [SECURITY.md](../SECURITY.md) 中有讨论但没有被实际演练。
7. **标准 14 的升级理由没有升级计数器支撑。** 理由
   `escalation_requested_at_maximum_pressure` 被无条件附加到每个第 4 级候选。要么补上计数
   器，要么改掉这个理由字符串；断言当前行为的测试只会把这个不一致固化下来。

上一版本文档以来已补上的缺口：

- **provider 退避已有覆盖**：`applies an exponential backoff after the failure limit and retries
  later` 让某个 provider 越过 `providerFailureLimit`，并断言跳过与恢复。
- **审计日志已有覆盖**：`writes and reads back a JSONL log with a schema version`、
  `tolerates a truncated trailing line`、`never throws when the log directory cannot be written`、
  `rotates the file once it exceeds the size budget`、`keeps a bounded in-memory ring` 以及
  `writes the decision log when a state directory is provided`。
- **工具表面与报告渲染器已有覆盖**：`tests/plugin.test.js` 的四个套件，其中包括
  `never exports anything that could restart or kill a process` —— 标准 1 的自动化一半。
- **插件入口的容纳能力已部分覆盖**：
  `rejects a bad configuration loudly but keeps running on the default preset`、
  `runs without a tools service and says so`、`runs without a settings service and says so`、
  `contains a throwing event listener` 与 `does not sample at all when disabled`。
- **每日汇总已有覆盖**：`tests/rolling.test.js` 的 `daily summaries` 套件。
- **tick 节奏已有覆盖**：`scheduler clock discipline` 套件断言循环绝不会快于
  `sampling.intervalMs` 采样。
