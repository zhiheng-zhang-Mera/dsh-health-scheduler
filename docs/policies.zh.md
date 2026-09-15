# 策略：动作阶梯、防抖与维护

[English](policies.md) | 中文

策略引擎（`src/core/policy.ts`）每一拍只回答一个问题：*现在应该发生什么？* 它读取一个压力数值
和一份维护画面，应用滞回、防抖、驻留与冷却规则，最多产出一个动作。它从不触碰进程、队列或设备，
而且除了调度器回传给它的状态之外，它自己不保留任何状态。

## 动作阶梯

`DECISION_LADDER` 与 `ACTION_LEVEL` 固定词表与顺序：

| 等级 | 动作 | `ACTION_LEVEL` | 由谁执行 |
| --- | --- | --- | --- |
| 0 | `NO_ACTION` | 0 | 没人 |
| 1 | `THROTTLE` | 1 | 本插件，经 `WorkerControlAdapter.setConcurrencyLimit` |
| 2 | `PAUSE_NEW_WORK` | 2 | 本插件，经 `WorkerControlAdapter.pauseNewWorkers` |
| 3 | `REQUEST_APP_RESTART` | 3 | **`dsh-restart`**，经 `RestartAdapter.requestApplicationRestart` |
| 4 | `REQUEST_SYSTEM_REBOOT` | 4 | **`dsh-restart`**，经 `RestartAdapter.requestSystemRestart` |

动作名是 `REQUEST_SYSTEM_REBOOT`，不是 `REQUEST_SYSTEM_RESTART`。适配器方法名是
`requestSystemRestart`，请求的 `mode` 是 `'system'`；只有动作名说的是 reboot。

`resolveConfig` 对阶梯强制两条顺序规则，违反任一条就拒绝该文档：

- 每一级的 `enter` 必须**严格高于**上一级的 `enter`；
- 每一级的 `exit` **不得低于**上一级的 `exit`；
- 每个 band 自身必须满足 `exit < enter`。

### 三个预设的进入 / 退出带

| 级别 | conservative 进入/退出 | balanced 进入/退出 | aggressive 进入/退出 |
| --- | --- | --- | --- |
| `THROTTLE` | 47 / 38 | 55 / 45 | 63 / 52 |
| `PAUSE_NEW_WORK` | 60 / 51 | 70 / 60 | 81 / 69 |
| `REQUEST_APP_RESTART` | 68 / 58 | 80 / 68 | 92 / 78 |
| `REQUEST_SYSTEM_REBOOT` | 81 / 72 | 95 / 85 | 99 / 98 |

aggressive 的 reboot 级进入阈值是 99、退出阈值 98，因此在 `aggressive` 下第 4 级需要模型几乎完全
饱和。`PRESET_SCALES.aggressive.bands = 1.15` 作用于基数 95 会得到 109，所以 `scalePreset` 把
每个进入阈值限制在 99：一级没人够得着的阈值等于被静默删除的一级，而「只在模型被钉死在最大值时」
是一条站得住的激进策略，「永不」不是。同一个上限也保证三个预设的阶梯都严格递增，而
`resolveConfig` 会重新校验这个顺序，因此手写覆盖把它写反时会被拒绝而不是被接受。

### 实际验证过的阶梯行为

在 balanced 预设上以禁用防抖、驻留与重复间隔、每次从全新状态开始、且维护关闭的条件运行
`PolicyEngine.evaluate`：

| 压力 | 候选动作 | 生效动作 | 结果状态 |
| --- | --- | --- | --- |
| 0 / 40 / 45 | `NO_ACTION` | `NO_ACTION` | `HEALTHY` |
| 50 / 54 | `NO_ACTION` | `NO_ACTION` | `DEGRADED` |
| 55 / 60 / 69 | `THROTTLE` | `THROTTLE` | `THROTTLED` |
| 70 / 79 | `PAUSE_NEW_WORK` | `PAUSE_NEW_WORK` | `PAUSED` |
| 80 / 84 / 94 | `REQUEST_APP_RESTART` | **`PAUSE_NEW_WORK`** | `MAINTENANCE_PENDING` |
| 95 / 100 | `REQUEST_SYSTEM_REBOOT` | **`PAUSE_NEW_WORK`** | `ESCALATION_PENDING` |
| `null` | `NO_ACTION` | `NO_ACTION` | `DEGRADED` |

最后三行就是这个设计的全部要点：**阶梯可以请求重启，但由重启门禁决定这个请求是否真的被发出。**
在维护窗口关闭时 —— 也就是默认情况 —— 第 3 级或第 4 级的决策会被降级为 `PAUSE_NEW_WORK`，而
状态机记录下这个待处理的意图，而不是把它忘掉。

各级从上到下评估，因此满足条件的最高 `enter` 获胜。注意压力 50 给出的是 `NO_ACTION` 但状态是
`DEGRADED`：状态机的健康判据是**节流退出**带，而不是节流进入带。

## 滞回

已生效的动作只有在压力跌破**它自己的**退出带之后才会被释放：

```ts
const activeBand = ladder.find(([action]) => action === previous.action)?.[1]
if (activeBand !== undefined && pressure > activeBand.exit) {
  hysteresisHeld = true
  candidate = { action: previous.action, reasons: ['hysteresis_holds_active_action'] }
}
```

`hysteresisHeld` 会在 `DecisionEvaluation` 上报告，因此消费者能看到当前动作是被“保持”的，而不是
被重新论证的。两个边界值得知道：

- 滞回只在原始候选为 `NO_ACTION` 时生效。如果压力爬过**更高**的一级，阶梯会立即升级 —— 滞回
  只减慢释放，不减慢升级。
- 滞回在 `pressure > exit`（严格大于）期间保持上一个动作。恰好等于 `exit` 时动作被释放。

`tests/policy.test.js` 有一个专门的用例：`56, 54, 56, 54, …` 序列在每一次评估都产出
`THROTTLE`，因为 54 仍然高于 45 退出带。

## 防抖

```ts
if (ACTION_LEVEL[candidate.action] > activeLevel &&
    ACTION_LEVEL[candidate.action] >= ACTION_LEVEL.REQUEST_APP_RESTART &&
    antiFlap.debounceEvaluations > 1 &&
    consecutiveCandidate < antiFlap.debounceEvaluations) { … }
```

三个性质让它比“一切都防抖”窄得多：

1. 它只作用于**向上跨越** —— 严格高于当前生效动作的候选。
2. 它只作用于第 3 级及以上。第 1、2 级从不防抖。
3. 它只作用于**新**等级。计数器跟踪的是原始候选，并且只在候选与当前生效动作不同时才递增：

   ```ts
   consecutiveCandidate = candidate.action === previous.candidate
     ? previous.consecutiveCandidate + (candidate.action === previous.action ? 0 : 1)
     : 1
   ```

   因此一个在什么都没被应用时反复出现的候选仍然会累积，而已经在生效的动作不会重复累积。在默认
   `debounceEvaluations: 2` 下，一台刚变危重的机器第一次评估产出 `NO_ACTION` 并带理由
   `debounce_request_system_reboot_1_of_2`；第二次才动作。

4. 它从不**降低**动作。被防抖的候选保持 `previous.action`，所谓“降级”只是说没有新事情发生。

## 驻留

```ts
if (effective.action !== previous.action &&
    ACTION_LEVEL[effective.action] < ACTION_LEVEL.REQUEST_APP_RESTART &&
    ACTION_LEVEL[previous.action] < ACTION_LEVEL.REQUEST_APP_RESTART &&
    dwellElapsed < antiFlap.minStateDwellMs) { … }
```

驻留是防抖的镜像：它减慢第 3 级**以下**的、任一方向的切换，并且在切换的任一侧是重启级时不生效。
因此从 `THROTTLED` 恢复到 `NO_ACTION` 要等满驻留时间，而第一次跨出 `NO_ACTION` 永远不会被延迟。
`dwellElapsed` 从 `previous.sinceMs` 起算，而策略引擎只在动作或状态真正变化时才推进它。
`tests/policy.test.js` 直接断言了“第一次跨越不被延迟”。

## 三个冷却

| 冷却 | 桶 | balanced 默认 | 使用它的动作 |
| --- | --- | --- | --- |
| `cooldowns.throttleMs` | `throttle` | 5 分钟 | `THROTTLE`、`PAUSE_NEW_WORK` |
| `cooldowns.maintenanceMs` | `maintenance` | 30 分钟 | `REQUEST_APP_RESTART` |
| `cooldowns.escalationMs` | `escalation` | 60 分钟 | `REQUEST_SYSTEM_REBOOT`，以及 `NO_ACTION` |

`cooldownKindOf` 把动作映射到桶；`cooldownMsOf` 把桶映射到时长。`NO_ACTION` 因 `switch` 的
default 落到 `escalation`，但冷却从不为 `NO_ACTION` 查询，因此这个映射是惰性的。

### 冷却从“尝试”而不是“决策”开始

这是最容易搞错的部分，而代码对此说得很明确：

```ts
// src/core/scheduler.ts
private noteAttempt(action: DecisionAction, atMs: number): void {
  if (action === 'NO_ACTION') return
  const kind = cooldownKindOf(action)
  this.attempts = {
    lastAttemptAt: atMs,
    lastAttemptAction: action,
    cooldowns: { ...this.attempts.cooldowns, [kind]: atMs + cooldownMsOf(this.config, action) },
  }
}
```

只要 `applyAction` 返回了非 `null` 的结果，`noteAttempt` 就会被调用 —— **包括适配器拒绝或抛
异常的情况**。源码注释陈述了理由：冷却存在的意义是给**能力**定节奏，因此拒绝也必须启动它。否则
一个缺失的 `dsh-restart`，或一个总是拒绝的重启适配器，会每拍产生一次请求。

调度器还在**动作发生点**额外强制一道重复守卫：

```ts
if (action === this.attempts.lastAttemptAction && cooldownUntil > this.clock()) return null
```

因此只要对应的桶还在冷却，相同的动作甚至不会被重新尝试。这正是把
`tests/scenarios.test.js` 那个 30 分钟、120 次评估、永久危重的场景限制在最多 3 次适配器调用的
机制。

### 重复抑制 vs 降级延迟

这种不对称是刻意的，并且写在源码里：

- 被抑制的**重复**会抑制该动作：只有生效动作等于上一个动作时 `repeatSuppressed` 才为真，而记录
  给状态机的动作变成 `NO_ACTION`。
- 被抑制的**降级**只是被延迟：压力跌破退出带永远不会被冷却阻止。

`minRepeatActionMs` 是第四条独立的节奏规则：与上一次尝试相同的动作，在
`nowMs - lastAttemptAt < antiFlap.minRepeatActionMs` 期间被抑制，与桶冷却无关。

### 冷却理由

| 理由字符串 | 含义 |
| --- | --- |
| `throttle_cooldown_active` / `maintenance_cooldown_active` / `escalation_cooldown_active` | 桶仍在冷却，且该动作是重复。 |
| `throttle_cooldown_delays_transition` / …… | 桶仍在冷却，但动作与当前生效的不同，因此只是被延迟。 |
| `min_repeat_action_interval` | 与上一次尝试相同的动作，落在 `minRepeatActionMs` 之内。 |

`DecisionEvaluation.cooldownActive`、`.cooldownKind` 与 `.cooldownRemainingMs` 以结构化形式
携带同样的信息。

## 重启门禁

重启是请求，不是权利。只要生效动作是第 3 或第 4 级，`gateRestart` 就会运行，并且可以阻止它并
降级为 `PAUSE_NEW_WORK`：

| 条件 | 是否阻止 | 追加的理由 |
| --- | --- | --- |
| `restartCapability !== 'available'` | 是 | `restart_capability_unavailable` |
| 动作是第 4 级且能力不可用 | 是 | `system_reboot_requires_restart_adapter` |
| `maintenance.urgentOverride` 为真 | **否** | `urgent_override_active` |
| 窗口关闭 | 是 | `maintenance_window_closed`、`maintenance_<phase>` |
| 窗口开启但 `phase === 'before_target'` | 是 | `maintenance_before_target_time` |
| 安全点 `safe === true` | 否 | `safe_point_confirmed`、`safe_point_<state>` |
| 安全点 `safe === false` | 是 | `safe_point_unsafe`、`safe_point_reason_<reason>` |
| 安全点 `safe === null`（未知） | 是 | `safe_point_unknown`、`safe_point_reason_<reason>` |
| `readiness` 为 `null`（不要求安全点） | 否 | 无 |

两个豁免，都很窄，而且都不静默：

- **紧急覆盖跳过窗口**，这正是设计稿的场景 C。它**不**跳过安全点。
- **只有第 4 级能覆盖安全点**，而且必须同时处于紧急覆盖状态：

  ```ts
  const escalateAnyway = action === 'REQUEST_SYSTEM_REBOOT' && input.maintenance.urgentOverride
  if (blocked && escalateAnyway && input.restartCapability === 'available') {
    return { blocked: false, reasons: [...reasons, 'escalation_overrides_safe_point'], … }
  }
  ```

  此时理由列表同时包含阻止理由**和** `escalation_overrides_safe_point`，因此审计轨迹永远会说
  安全点没有被确认。注意仍然要求重启能力可用 —— 这个覆盖绕过的是安全点和窗口，从来不是重启适配器
  的缺席。

只有当生效动作是重启时才会查询门禁。如果阶梯产出的是 `THROTTLE` 或 `PAUSE_NEW_WORK`，门禁不
运行，也不会追加任何理由。

## 分派：指标到维度

`dimensionOf` 通过 `src/core/pressure.ts` 中一张冻结的表把规范指标名映射到六个压力维度之一。
这个映射与指标的注册表**分组**并不相同，这对两个指标很重要：

| 指标 | 注册表分组 | 压力维度 |
| --- | --- | --- |
| `task_failure_rate` | `context` | **`worker`** |
| `git_operations_per_minute` | `context` | **`time`** |
| `ipc_timeout_rate` | `runtime` | `runtime` |
| `uptime_seconds` | `runtime` | **`time`** |

其余一切映射到同名的维度：`hardware` 指标到 `thermal`，`memory` 到 `memory`，`runtime` 到
`runtime`，`workers` 到 `worker`，`computer-use` 与 `ui` 到 `computer_use_ui`。

**内存指标不会被重复计入运行时。** 设计稿的“runtime 劣化”清单里有“进程 handle 增长”和
“线程增长”，把 `process_rss_bytes` 也折进 runtime 本来是很自然的做法。代码刻意没有这么做：

```ts
// `runtime` 指标通过 runtime 维度保持可见；memory 维度只拥有真正的内存遥测。
// handle 与 thread 增长作为显式的 runtime 劣化 driver 在策略层体现，
// 而不是在这里被重复计入。
```

因此 `handle_count` 与 `thread_count` **只**通过 `runtime` 维度、并且**只**通过它们的趋势项
抵达压力。`process_rss_bytes` 与 `process_private_bytes` **只**通过 `memory` 维度抵达。
`ram_total_bytes` 是容量事实，完全不打分。

## 安全点折叠

安全点回答的是“现在是不是好时机？”。调度器提问，但不保存答案。

`SafePointRegistry.readiness(timeoutMs = 1000)` 并发询问每个已注册的源。抛异常的源变成
`{safe: null, reason: 'safe_point_source_failed'}`；在单源预算内没有回答的源变成
`{safe: null, reason: 'safe_point_timeout'}`。两者都不会让本拍超出预算。

`foldReadiness` 随后按“最差优先”归并这些读数：

| 输入 | `safe` | `reason` | `estimated_state` |
| --- | --- | --- | --- |
| 没有注册任何源 | `null` | `no_safe_point_source` | `unknown` |
| 任一源说 `false` | `false` | 该源的 reason | 任一源报告过的最差状态 |
| 没有 `false`，但有 `null` | `null` | 该源的 reason | `unknown` |
| 全部说 `true` | `true` | `safe_point_reached` | 任一源报告过的最差状态 |

`estimated_state` 使用 `STATE_RANK = { idle: 0, busy: 1, critical: 2, unknown: 3 }`，因此
出于展示目的 `unknown` 被当作最忙的状态。注意表中有一处不对称：当有东西不安全时，
`estimated_state` 反映**任一**源报告的最差状态；当只是未知时，状态被强制为 `unknown`。

唯一重要的规则是：**没有回答不等于 `yes`。** 在 `maintenance.safePointRequired: true`
（默认）且没有注册任何源时，第 3 级请求会被以 `safe_point_unknown` 阻止。这也是为什么 balanced
默认的 `maintenance.enabled: false` 配 `safePointRequired: true` 是自洽而非矛盾的：维护关闭时
整个门禁在窗口那一步就被绕过了，安全点永远不会成为阻止请求的理由。

当 `safePointRequired: false` 时，调度器甚至不查询注册表 —— 它合成
`{safe: null, reason: 'safe_point_not_required'}` 并将其作为 `readiness` 传入。由于门禁把
`null` readiness 视为“不要问”，安全点被完全跳过。

## 维护窗口状态机

`maintenanceAllowsRequest(picture, config)` 是粗粒度的答案：

```ts
if (!config.enabled || !config.allowAppRestart) return false
if (picture.phase === 'urgent_override') return true
if (!picture.windowOpen) return false
return picture.phase !== 'before_target'
```

注意策略引擎**并不**调用这个函数 —— 它在 `gateRestart` 中重新实现了同样的条件，以便附加理由。
`maintenanceAllowsRequest` 是给嵌入者用的库便利函数，由 `tests/maintenance.test.js` 覆盖。

### 阶段

`computeMaintenancePicture` 解析出“现在开着或下一次打开”的窗口实例，把目标算作该实例上的
`windowStart + (targetTime - windowStart)`，然后挑选一个阶段：

| 阶段 | 条件 | `windowOpen` | 允许请求 |
| --- | --- | --- | --- |
| `urgent_override` | 压力 ≥ `urgentOverridePressure`（且它不为 `null`） | 无关 | **是**，忽略窗口 |
| `outside_window` | `now` 不在窗口内 | `false` | 否 |
| `before_target` | 在窗口内，`now < target` | `true` | **否** |
| `at_target` | 在窗口内，`now === target` | `true` | 是 |
| `deferred` | 已过目标，推迟预算还有剩余 | `true` | 是 |
| `overdue` | 已过目标，`deferExhausted` | `true` | 是 —— “现在就走”，而不是“放弃” |

紧急覆盖判定**最先**评估，因此窗口内的一台紧急机器报告的也是 `urgent_override` 而不是
`at_target`。

`MaintenancePicture` 的其他字段：

- `nextTargetAt` —— 目标的 ISO-8601，维护关闭时为 `null`。
- `windowClosesInMs` —— 距窗口关闭的毫秒数，关闭后为 `0`。按 `max(0, openEnd - now)` 计算。
- `deferredMs` —— `max(0, min(now, openEnd) - deferredSinceMs)`，因此推迟永远不会算过窗口结束。
- `deferExhausted` —— `deferredSinceMs !== null && deferredMs >= maxDeferMs`。
- `urgentOverride` —— 与产生阶段相同的判定。
- `summary` —— 人类可读的一行，例如 `deferred 40m 0s of 1h 0m` 或
  `next window 03:30-05:00`。

### 验证过的阶段

balanced 默认（`targetTime 04:00`、窗口 `03:30`–`05:00`、`maxDeferMs` 60 分、
`urgentOverridePressure` 92）：

| 本地时间 | `deferredSince` | 压力 | 阶段 | `windowOpen` | `deferredMs` |
| --- | --- | --- | --- | --- | --- |
| 02:00 | `null` | 10 | `outside_window` | `false` | 0 |
| 03:45 | `null` | 10 | `before_target` | `true` | 0 |
| 04:00 | `null` | 10 | `at_target` | `true` | 0 |
| 04:10 | 04:00 | 10 | `deferred` | `true` | 600 000 |
| 04:40 | 04:00 | 10 | `deferred` | `true` | 2 400 000 |
| 14:00 | `null` | 93 | `urgent_override` | `false` | 0 |
| 14:00 | `null` | 91 | `outside_window` | `false` | 0 |

### 推迟账本

画面本身是无状态计算的；`deferredSinceMs` 账本由 `HealthScheduler` 持有。它在一拍看到窗口开启时
被设置，在看到关闭且 `windowClosesInMs === 0` 的窗口时被清空：

```ts
if (picture.windowOpen && this.deferredSinceMs === null) {
  this.deferredSinceMs = Math.max(nextTargetAt === null ? nowMs : Date.parse(nextTargetAt), nowMs)
}
if (!picture.windowOpen && picture.phase === 'outside_window' && (this.deferredSinceMs ?? 0) > 0) {
  if (picture.windowClosesInMs === 0) this.deferredSinceMs = null
}
```

账本只在内存中。调度器重启后，它会从下一个窗口的开始重新计时。

### 墙钟算术

窗口用本地日历字段表达，从不使用固定的毫秒偏移，因此它能跨过夏令时。`startOfLocalDay` 加
`parseClock` 构造每个时刻；`clockWithin` 处理跨过午夜的窗口（`23:00`–`02:00`）；
`previousOccurrence` 与 `nextOccurrence` 找到某个 `HH:MM` 前后的实例。
`tests/maintenance.test.js` 在四个不同的日期上验证了类似春季前跳的日边界。

## 状态机

`stateFor` 从当前生效的动作**以及**上下文导出 `MachineState`，这正是被门禁拦下的重启仍然可见的
原因：

| 生效动作 | 上下文 | 状态 |
| --- | --- | --- |
| `NO_ACTION` | 原始动作是被门禁拦下的第 3 级 | `MAINTENANCE_PENDING` |
| `NO_ACTION` | 原始动作是被门禁拦下的第 4 级 | `ESCALATION_PENDING` |
| `NO_ACTION` | 上一个状态是 `REQUEST_SYSTEM_REBOOT` | `SAFE_MODE` |
| `NO_ACTION` | 压力为 `null` | `DEGRADED`（若上一状态已经是 `HEALTHY` 则保持原状态） |
| `NO_ACTION` | 压力 ≤ `thresholds.throttle.exit` | `HEALTHY` |
| `NO_ACTION` | 其他 | `DEGRADED` |
| `THROTTLE` | 被拦下的第 4 级 | `ESCALATION_PENDING` |
| `THROTTLE` | 被拦下的第 3 级 | `MAINTENANCE_PENDING` |
| `THROTTLE` | 其他 | `THROTTLED` |
| `PAUSE_NEW_WORK` | 被拦下的第 3 / 第 4 级 | `MAINTENANCE_PENDING` / `ESCALATION_PENDING` |
| `PAUSE_NEW_WORK` | 其他 | `PAUSED` |
| `REQUEST_APP_RESTART` | — | `REQUEST_APP_RESTART` |
| `REQUEST_SYSTEM_REBOOT` | — | `REQUEST_SYSTEM_REBOOT` |

两个细节：

- `MAINTENANCE_PENDING` 与 `ESCALATION_PENDING` 就是“我们想重启但做不到”的状态，它们在
  `THROTTLE` 作为生效动作时同样可达，不只是 `PAUSE_NEW_WORK`。
- `NO_ACTION` / 压力为 `null` 那一行是刻意为之，而且略微反直觉：只有当上一个状态是 `HEALTHY`
  时才返回 `DEGRADED`，否则保持已经持有的状态。意图是“失去全部遥测”绝不能被报告为 `HEALTHY`，
  而实现做到这一点的方式是不丢弃已经表达了更糟情况的状态。
- `SAFE_MODE` 只能从上一个 `REQUEST_SYSTEM_REBOOT` 到达，即在系统重启确实被请求过、且压力随后
  回落之后。它是一个稳定的平静状态，不是错误状态。

## 理由码

每条决策都携带一个去重且保持顺序的理由列表。引擎只会产出以下前缀：

| 前缀 | 例子 |
| --- | --- |
| `pressure_` | `pressure_84_gte_app_restart_80` |
| `maintenance_` | `maintenance_window_closed`、`maintenance_deferred`、`maintenance_before_target_time` |
| `safe_point_` | `safe_point_confirmed`、`safe_point_unsafe`、`safe_point_unknown`、`safe_point_reason_git_commit_in_progress` |
| `hysteresis_` | `hysteresis_holds_active_action` |
| `dwell_` | `state_dwell_15s_of_120s`、`dwell_suppressed_transition` |
| `debounce_` | `debounce_request_system_reboot_1_of_2` |
| `coverage_` | `coverage_60pct` |
| `throttle_cooldown` / `maintenance_cooldown` / `escalation_cooldown` | `…_active`、`…_delays_transition` |
| `min_repeat_action_interval` | — |
| `urgent_override_active` | — |
| `restart_capability_unavailable` | — |
| `system_reboot_requires_restart_adapter` | — |
| `escalation_overrides_safe_point` | — |
| `escalation_requested_at_maximum_pressure` | 无条件附加到每个第 4 级候选 |
| `uptime_pressure` | 一个 driver code，不是理由前缀，但列在测试词表中 |
| driver code | 前三个 driver code 会被追加到每个 `pressure_*` 候选 |

`coverage_NNpct` 会被追加到**每一条**决策，因此消费者永远能知道决策当下模型的多少部分是被真正
测量过的。

`escalation_requested_at_maximum_pressure` 值得单独指出：它被无条件附加到每个第 4 级候选，
但引擎中没有任何东西真的去验证此前有一次应用重启失败过。`0.1.0` 里既没有升级计数器，也没有重启
结果的反馈回路 —— 升级纯粹是因为压力越过了第 4 级进入阈值。这个理由字符串夸大了引擎所知道的
信息量。

## 策略引擎不做什么

- 它不执行动作。`PolicyEngine.evaluate` 是纯函数：给定输入与上一个状态，返回一条决策和下一个
  状态，而 `HealthScheduler.applyAction` 是唯一调用适配器的地方。
- 它不拥有冷却。尝试日志放在调度器里，因为只有调度器知道适配器是否真的被调用了。
- 它不保存任务状态、不跑 checkpoint、不持有锁。那些属于 DS-Hns Core 与 `dsh-restart`。
- 它自己不看时钟。`nowMs` 与 `timestamp` 作为输入到达，这正是 `tests/policy.test.js` 能够确定
  性地驱动它的原因。
