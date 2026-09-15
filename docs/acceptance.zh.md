# 验收

[English](acceptance.md) | 中文

本文档把设计稿的验收标准与关键场景映射到真正验证它们的测试上。下面每个测试名都是真实的，且按提交
状态测试套件全部通过：

```sh
node --test tests/*.test.js
# tests 87 / suites 16 / pass 87 / fail 0
```

测试文件：

| 文件 | 套件 | 覆盖内容 |
| --- | --- | --- |
| `tests/normalization.test.js` | `canonical metric registry`、`normalizeSample`、`band scoring`、`sustain gate` | 词表、物理边界、爬升、持续时间门。 |
| `tests/rolling.test.js` | `RollingStore`、`TrendAnalyzer` | 窗口统计、保留下限、band 计时、斜率与 R² 门槛、投影、格式化。 |
| `tests/policy.test.js` | `action ladder`、`anti-flapping`、`restart gate`、`machine states` | 阈值、滞回、防抖、驻留、冷却、重启门禁、状态机。 |
| `tests/maintenance.test.js` | `wall-clock parsing`、`maintenance picture`、`safe points` | 窗口算术、全部六个阶段、推迟账本输入、安全点折叠。 |
| `tests/scenarios.test.js` | `synthetic scenarios`、`synthetic scenario invariants`、`scenario rig self-checks` | 六个设计场景端到端跑真实的调度器，外加不变式与 rig 自检。 |

测试夹具：`tests/helpers/rig.js`（带可注入时钟、脚本化 provider、记录型适配器与脚本化安全点的
`ScenarioRig`）以及 `tests/helpers/drive.js`（共享的动作、状态与理由词表，以及 `drive()` 循环）。

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
| 14 | system reboot 只用于升级路径。 | 部分：第 4 级要求压力 ≥ 它自己的 `enter`，而该值严格高于第 3 级的，且 `gateRestart` 会追加 `system_reboot_requires_restart_adapter`。但理由字符串 `escalation_from_repeated_app_restart_failure` 是无条件附加的 —— **没有**升级计数器，也没有重启结果的反馈回路，因此引擎并没有真的验证此前有一次应用重启失败过。 | **部分** |
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
| 从 `os.cpus()` 测量 `cpu_usage` | 否 —— rig 脚本化它 | 是。差分在某台机器上是否合理是真机问题。 |
| 从 `process.getActiveResourcesInfo()` 取 `handle_count` | 否 | 是。该代理只在真实运行时上才有意义。 |
| 从 `os` 取 `ram_*` 与 `process_rss_bytes` | 否 | 是。 |
| 配置的辅助命令确实产出可解析的行 | 否 | 是。`runCommandProbe` 在测试中只通过环境接缝被触及。 |
| 真实集成写入 stats 文件 | 否 | 是。 |
| 心跳文件 mtime 跟随活跃事件循环 | 否 | 是。 |
| 任何真实重启请求抵达 `dsh-restart` | 否 | 是。仓库里没有 `dsh-restart` 适配器。 |
| worker-control 真正改变并发 | 否 | 是。测试中没有绑定任何 harness worker-control 服务。 |
| 卸载后 DS-Hns 不受影响 | 否 | 是。 |
| 6 小时 / 12 小时合成与 24 小时 soak | 否 —— 长跑测试层未实现 | 是，且合成层本可以自动化 |

## 已知覆盖缺口

如实陈述，以便维护者决定先补哪个：

1. **没有长跑测试层。** 标准 17 只验证了 30 分钟的场景时间，而不是 6 或 12 小时。用现有 rig 跑
   6 小时合成很便宜（时钟是注入的，所以只是一次 tick 循环），并且会远更有说服力地支撑“无决策
   风暴”这一主张。
2. **没有测试 provider 退避窗口被遵守。** 熔断器的 `disabledUntil`、`skipped` 列表与指数调度都
   未被验证。rig 的 `failNext(n)` 加一次时钟跳变就能覆盖。
3. **没有测试 `normalizeSample` 的硬边界对齐。** `1e-9` 相对容差路径（刚好在边界内的值被对齐而
   不是被拒绝）没有被断言。
4. **完全没有审计日志的测试。** `DecisionLog` 的轮转、`readPersisted`、写了一半的尾行以及写入
   失败路径都没有覆盖。
5. **没有 `registerTools`、`renderHealthReport` 或 `metricsSnapshot` 的测试。** 面向模型的表面
   与报告渲染器未被测试；对一个固定快照做黄金输出测试成本很低。
6. **没有 `resolveConfig` 的测试。** 校验规则被文档化并间接执行（每个测试都调用
   `resolveConfig`），但拒绝消息本身没有被断言。
7. **没有设置命名空间或 `reconfigure` 的测试。** 实时重载路径未被验证。
8. **没有断言 `apply` 是防御性的。** 入口的容纳是结构性的（配置错误、provider 失败、适配器
   失败、安全点失败与逐工具注册失败都被捕获），但没有被断言。用一个最小的假 `ctx` 和一份畸形
   配置调用 `applyHealthScheduler` 就能确认。
9. **标准 14 的升级理由没有升级计数器支撑。** 理由
   `escalation_from_repeated_app_restart_failure` 被无条件附加到每个第 4 级候选。要么补上计数
   器，要么改掉这个理由字符串；断言当前行为的测试只会把这个不一致固化下来。
