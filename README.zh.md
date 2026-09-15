# dsh-health-scheduler

[English](README.md) | 中文

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D20.11.0-brightgreen.svg)
![DSH](https://img.shields.io/badge/DSH-cordis%20%5E4.0.1-6f42c1.svg)
![Plugin type](https://img.shields.io/badge/type-DSH%20bundle%20plugin-orange.svg)

**面向 DeepSeek Harness 的设备/运行时健康监控、重启压力评分、维护调度与动作决策插件 —— 它自己从不重启任何东西。**

`dsh-health-scheduler` 观察一台 DS-Hns 机器，把它能测到的一切归结为一个 0 到 100 的
`restart_pressure` 数值，判断接下来*应该*发生什么，然后请别人去做。动作阶梯的第 1、2 级交给
worker-control 适配器；第 3、4 级是投递给独立的
[`dsh-restart`](https://github.com/zhiheng-zhang-Mera/dsh-restart) bundle 的**请求**，重启执行由后者负责。

流水线只有一个方向：

```text
providers -> normalization -> rolling windows -> trend -> pressure -> policy
          -> maintenance scheduler -> action adapters (worker control | restart request)
```

## 它是什么 / 它不是什么

| 关注点 | 归属 | 本插件的角色 |
| --- | --- | --- |
| 感知设备与运行时健康 | **Health Scheduler** | 归它。Provider 采样、规范化并保留历史。 |
| 判断状况有多糟 | **Health Scheduler** | 归它。压力模型与策略引擎都在这里。 |
| 调度维护 | **Health Scheduler** | 归它。窗口、目标时间、推迟预算、安全点。 |
| 降低负载（`THROTTLE`、`PAUSE_NEW_WORK`） | **Health Scheduler** | 通过 worker-control 适配器请求。 |
| 真正执行重启 | `dsh-restart` | **不归它。** 只发出请求并读取应答。 |
| 重启锁、限流、checkpoint、优雅关闭 | `dsh-restart` | 不在这里。 |
| 崩溃后拉起、崩溃循环熔断 | Supervisor | 不在这里。 |
| 任务状态、checkpoint、resume | DS-Hns Core | 不在这里。安全点查询只是一个*提问*，不是存储。 |
| 第二个 Mega Core | 谁都不该有 | 明确不在范围内。 |

上表推出三条承诺，而且它们是承重的：

1. **没有重启执行。** 没有 `taskkill`、没有 `reboot`、没有杀进程，也没有任何可能触及操作系统
   重启路径的 `child_process` 调用。整个代码库里唯一的 `execFile` 用来运行**用户配置的遥测探测
   命令**（`src/providers/sources.ts`）。
2. **没有遥测就是 `unknown`，绝不是健康。** 没有任何数据的维度得分为 `null`，其名义权重被重新
   分配给真正有数据的维度。
3. **单点采样永远不会驱动高风险动作。** 每个被打分的指标都要过持续时间门（sustain gate），
   每个指标背后都有滚动窗口，而阶梯最高的两级还额外经过防抖、维护窗口门禁与安全点门禁。

## 安装

`dsh plugin --profile <name> <pnpm args>` 会把剩余参数转发给 profile 目录中的 `pnpm`，然后
对该 profile 的 bundle 列表做一次对账，因此一个声明了 `dsh.bundle` 的已安装包会自动加入层栈。

从本仓库的本地检出安装：

```sh
# Windows PowerShell，在检出目录中执行
dsh plugin --profile web add <检出路径>\dsh-health-scheduler
```

```sh
# 任意平台，在检出目录中执行（裸 "." 会锚定到你的当前目录）
cd dsh-health-scheduler
dsh plugin --profile web add .
```

从包名或 tarball 安装：

```sh
dsh plugin --profile web add dsh-health-scheduler
dsh plugin --profile web add ./dsh-health-scheduler-0.1.0.tgz
```

### bundle 贡献了什么

`cordis.patch.yml` 插入一行 `id: health-scheduler`，它的 `config` 块以带注释的形式重述了整份
`balanced` 预设。该层在每个更早的 bundle 之后、你自己的 profile `cordis.patch.yml` 之前应用，
因此你的覆盖会生效。

**patch 会替换目标行的整个 `config`，它不是深合并。** 如果你在 profile patch 里覆盖
`providerOptions`，请复制你想改的整个嵌套对象，而不是只写那一个叶子。插件自己的配置解析**是**
在所选预设之上的深合并，所以你直接传给插件的文档行为符合直觉 —— 是 profile patch 这一层在做
替换。

`plugin/manifest.json` 以机器可读的形式描述同一份契约：id、kind、入口模块、安装命令与 patch
路径、必需与可选服务、设置命名空间、三个工具名、六种事件名、本插件亲自应用的动作与仅作为请求发出
的动作，以及在 `dsh-restart` 或 worker control 缺席时哪些能力会降级。

### 启动前先验证

`--dump-config` 会在不启动的情况下打印组合后的 profile 树。用它确认插件行存在、且配置就是你写的
那份：

```sh
dsh --profile web --dump-config
```

`--dump-default-config` 打印的是**不含**用户层、也不含任何 `--patch` 覆盖的同一棵树，是查看本
插件贡献了什么最快的方式。

### 启动

```sh
dsh --profile web
```

`dsh web` 是 `--profile web` 的硬编码别名。

### git 安装的注意事项

由 git 托管的插件在安装时通过 `prepare` 脚本构建，而 pnpm 会阻止该构建，直到你明确允许。当
`dsh plugin ... add git+https://…` 失败时，CLI 会打印 pnpm 要求的确切键名；把它加到
`<profile 目录>/pnpm-workspace.yaml` 的 `allowBuilds` 下，然后重跑同一条命令。

本插件带有 `"prepack": "npm run build"`，且 **`lib/` 被 gitignore**，因此：

- **从 npm 或 tarball 安装不需要构建许可。** 发布的 tarball 里包含由 `prepack` 钩子构建出的
  `lib/`。
- **从 git URL 安装总是需要那条 `allowBuilds` 记录**，因为检出里没有 `lib/`，必须先由
  `prepack` 跑 `tsc` 才能生成它。
- **从本地路径安装**在你已经跑过 `npm run build` 时等同于 tarball，否则需要先构建一次。

## 快速开始

插件零配置即可工作 —— `balanced` 预设就是默认值，其中每个叶子都是默认值而非铁律。最小可用的
配置文档只有一行：

```jsonc
// profile package.json -> dsh.profile，或插件的设置命名空间
{ "preset": "balanced" }
```

一份更接近真实使用的首版配置会打开定时维护窗口，并把硬件 provider 指向一个温度辅助命令：

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: health-scheduler
  name: dsh-health-scheduler
  config:
    preset: balanced
    maintenance:
      enabled: true
      targetTime: '04:00'
      windowStart: '03:30'
      windowEnd: '05:00'
      maxDeferMs: 3600000
      urgentOverridePressure: 92
      safePointRequired: true
    providerOptions:
      hardware:
        helperCommand: ['powershell', '-NoProfile', '-File', 'C:\\dsh\\gpu-temp.ps1']
        helperTimeoutMs: 5000
      statsFile:
        paths: ['C:\\dsh\\telemetry\\metrics.json']
        staleAfterMs: 120000
```

启动后插件会打印

```text
health-scheduler: monitoring started (7 providers, interval 15000 ms, preset balanced)
```

按需请求时，只读健康报告的开头是这样：

```text
Restart Pressure: 21 / 100
State: THROTTLED
Primary Cause: gpu_usage=95.00 pp scores 89/100, held 1260s
Telemetry coverage: 60%
Unknown dimensions: runtime, worker, computer_use_ui (not scored as healthy)
Maintenance: next window 03:30-05:00
Safe point: no safe-point source registered; readiness unknown
Capabilities: restart=unavailable, worker-control=unavailable
```

其中每个数字都能追溯到某个指标。输出里不存在任何不由测量支撑的句子 —— “AI 认为应该重启”不是
一个可能的 reason code。

## 工作原理

### 1. Provider 采样；别的地方不接触外部世界

所有健康数据都通过 `HealthProvider` 进入。压力模型与策略引擎被禁止直接触达 NVML、
LibreHardwareMonitor、HWiNFO、Windows API、worker 内部或 Electron 内部。测不到某个指标的
provider 会**省略该键**；缺席是表达“未知”的唯一方式，而且它刻意不写成 `0`。

### 2. 规范化：拒绝、钳制、排序

`normalizeSample` 把原始样本转换为规范词表。不是有限数字、或越过该指标物理硬边界的读数会被丢弃
并记录为 violation。以百分比形式送来的 `ratio`（`1.0 < v <= 1.5`）会被钳制为 `1` 并附一条
violation，而不是被静默接受。存活的指标包按指标名排序，因此快照是稳定的。

### 3. 滚动窗口，而不是单点

每个指标都保留 `windows.rawMs`（默认 30 分钟；若最长统计窗口更长则抬高到该值）内的原始样本，
以及按 `windows.aggregateBucketMs`（5 分钟）聚合的 mean/max/min 桶，保留
`windows.aggregateRetentionMs`（24 小时）。统计量在 5 分钟 / 30 分钟 / 2 小时 / 6 小时四个窗口
上计算。内存由构造方式保证有界：存储不随 uptime 增长。

### 4. 带极性的趋势分析

泄漏不是数值，而是斜率。只有当样本数不少于 `trend.minSamples`、跨度不短于 `trend.minSpanMs`
且 R² ≥ `trend.minRSquared` 时，`TrendAnalyzer` 才报告斜率。极性由指标注册表持有，因此 GPU
温度上升是恶化，`recovery_rate` *下降*也是恶化。

### 5. 六个维度，一个数字

每个指标从其 `warn` 端点（0 分）线性爬升到 `critical` 端点（100 分）；哪一端是哪一端由注册表
的极性决定。维度得分是其加权均值与该维度**最差**成员的混合，`WORST_WEIGHT = 0.5`，因此一个
危重指标不会被五个平静指标平均掉。六个维度得分再按配置权重合成。

### 6. 缺数据是 `unknown`，而 coverage 会说明这一点

没有已知指标的维度得分为 `null`，并被列入 `unknownDimensions`。它的名义权重被**重新归一化**
到真正有数据的维度上，而“被遥测真正支撑的那部分权重”会以 `coverage` 发布。40% coverage 的压力
读数永远不会被误认为满置信读数，并且每条决策记录的理由列表里都带着 `coverage_NNpct`。

### 7. 防抖不是可选项

四套彼此独立的机制，防止插件自己变成扰动源：

| 机制 | 默认值 | 它阻止了什么 |
| --- | --- | --- |
| 持续时间门 | 逐指标，例如 `gpu_temp_c` 60 秒 | 30 秒的尖峰完全得不到分。 |
| 滞回 | 例如节流 55 进入、45 退出 | `55 -> throttle, 54 -> normal, 56 -> throttle`。 |
| 防抖 | 连续 2 次评估 | 单次评估就升级到高风险等级。 |
| 驻留 | 120 秒 | 低于重启等级的任何切换快于驻留时间。 |
| `minRepeatActionMs` | 10 分钟 | 早于允许间隔重复下发同一动作。 |
| 三个冷却 | 5 / 30 / 60 分钟 | 决策风暴，包括由**失败**适配器引发的风暴。 |

冷却从适配器**真正被调用**时开始计时 —— 包括它拒绝或抛异常的情况。
`tests/scenarios.test.js` 让一台永久危重的机器以 15 秒一拍跑满 30 分钟，且重启适配器一直抛
异常，断言最多只有 3 次尝试抵达适配器，而不是每拍一次。

### 8. 先策略，后适配器

策略引擎每拍最多产出一个动作，并且从不触碰进程。第 1、2 级交给 `WorkerControlAdapter`；第 3、
4 级变成一个交给 `RestartAdapter` 的 `RestartRequest`。每个被应用的动作恰好产生一条审计记录，
包含压力、coverage、具名 driver、reason code 以及适配器的应答。

## 面向模型的工具

当 profile 提供工具运行时时会注册三个工具。三者都是只读的：它们都不会行使任何能力。

### `health_status`

报告 DS-Hns 运行时的当前健康状况。参数：`section`
（`full` | `pressure` | `maintenance` | `providers`，可选，默认 `full`）。

```text
health_status({ "section": "pressure" })

Restart Pressure: 21 / 100
State: THROTTLED
Coverage: 60%
Primary cause: gpu_usage=95.00 pp scores 89/100, held 1260s
  [0.3] gpu_usage_critical: gpu_usage=95.00 pp scores 89/100, held 1260s
  [0.2] cpu_usage_critical: cpu_usage=90.00 pp scores 71/100, held 1260s
  [0.2] gpu_temp_c_critical: gpu_temp_c=88.00 °C scores 71/100, held 1260s
```

`full` 是整份报告：压力、状态、主因、coverage、未知维度、维护摘要、安全点摘要、能力状态、
逐维度表格、driver、恶化趋势、provider 状态、内存行、最近五条决策以及本拍的 warnings。
`maintenance` 与 `providers` 是同一份快照的单主题视图。

### `health_history`

返回某个规范指标的滚动窗口统计。

| 参数 | 类型 | 必填 | 含义 |
| --- | --- | --- | --- |
| `metric` | string | 是 | 规范指标名，例如 `gpu_temp_c`。 |
| `window_minutes` | number | 否 | 只输出不大于该分钟数的窗口。 |

未知指标名会抛错，错误信息里带完整规范名称列表。

```json
{
  "metric": "process_rss_bytes",
  "windows": [
    {
      "window_minutes": 30,
      "count": 120,
      "mean": 2540000000,
      "p95": 2870000000,
      "max": 2900000000,
      "latest": 2880000000,
      "slope_per_hour": 1200000000,
      "r_squared": 0.9821,
      "consecutive_ms": 0,
      "span_ms": 1785000
    }
  ]
}
```

### `health_policy`

解释决策策略。参数：`action`（`explain` | `config` | `decisions`，可选，默认 `explain`）。

```text
health_policy({ "action": "explain" })

Action ladder (enter/exit pressure):
  1 THROTTLE              enter >= 55, exit <= 45
  2 PAUSE_NEW_WORK        enter >= 70, exit <= 60
  3 REQUEST_APP_RESTART   enter >= 80, exit <= 68
  4 REQUEST_SYSTEM_REBOOT enter >= 95, exit <= 85

Levels 1 and 2 are applied by this plugin through the worker-control adapter.
Levels 3 and 4 are *requests* handed to dsh-restart, which owns restart execution.
A restart request is additionally gated by the maintenance window and by getMaintenanceReadiness().

Dimension weights: time=0.15, thermal=0.2, memory=0.25, runtime=0.15, worker=0.15, computer_use_ui=0.1
Weights are renormalized over the dimensions that actually have telemetry; the fraction that does is reported as coverage.
```

`config` 以 JSON 返回解析后的数值（`preset`、`thresholds`、`weights`、`cooldowns`、
`anti_flap`、`maintenance`、`windows_ms`、`sampling`）。`decisions` 以 JSON 返回最近 20 条
审计记录。

## 配置

配置是一份部分文档。它会被深合并到所选预设之上，所以你省略的每个叶子都来自预设；数组是替换而非
合并。当 profile 提供设置服务时，插件会注册设置命名空间 **`health-scheduler`**；没有设置服务时
它仅靠 bundle patch 运行。

有一点注意事项属于这里而不是配置参考：**profile patch 层不是深合并**。`cordis.patch.yml` 的一行
会替换目标行的整个 `config`，因此只重述某个嵌套对象一部分的覆盖会丢掉其余部分。本节描述的深合并
适用于插件实际收到的那份文档，见上文「bundle 贡献了什么」一节。

逐键完整参考（含 stats 文件格式与命令探测格式）在
**[docs/configuration.zh.md](docs/configuration.zh.md)**。

| 分组 | 键 | 默认值 |
| --- | --- | --- |
| 总开关 | `enabled`、`preset` | `true`、`balanced` |
| `sampling` | `intervalMs`、`trendIntervalMs`、`summaryIntervalMs`、`providerBackoffMs`、`providerBackoffMaxMs` | 15 秒、60 秒、300 秒、30 秒、600 秒 |
| `windows` | `rawMs`、`windowsMs`、`aggregateBucketMs`、`aggregateRetentionMs`、`dailyRetentionMs` | 30 分、`[5m,30m,2h,6h]`、5 分、24 小时、14 天 |
| `trend` | `minSamples`、`minSpanMs`、`minRSquared` | 3、5 分、0.5 |
| `weights` | `time`、`thermal`、`memory`、`runtime`、`worker`、`computer_use_ui` | 0.15 / 0.20 / 0.25 / 0.15 / 0.15 / 0.10 |
| `thresholds` | 每个动作一个 `{enter, exit}` 带 | 55/45、70/60、80/68、95/85 |
| `metrics` | 逐规范指标：`band`、`weight`、`sustainMs`、`trendPointsPerHour`、`trendCap` | 见 [docs/metrics.zh.md](docs/metrics.zh.md) |
| `cooldowns` | `throttleMs`、`maintenanceMs`、`escalationMs` | 5 分、30 分、60 分 |
| `throttle` | `concurrencyLimit`、`concurrencyFactor` | `null`、`0.5` |
| `maintenance` | `enabled`、`targetTime`、`windowStart`、`windowEnd`、`maxDeferMs`、`urgentOverridePressure`、`allowAppRestart`、`safePointRequired` | `false`、`04:00`、`03:30`、`05:00`、60 分、92、`true`、`true` |
| `antiFlap` | `minStateDwellMs`、`minRepeatActionMs`、`debounceEvaluations` | 120 秒、10 分、2 |
| `resilience` | `providerFailureLimit`、`providerRetryAfterBackoff`、`reportDegradedCapability` | 3、`true`、`true` |
| `storage` | `enabled`、`directory`、`maxLogBytes`、`maxRecentDecisions` | `true`、`null`、4 MiB、50 |
| Provider | `disabledProviders`、`providerOptions` | `[]`、见文档 |

无法被执行的配置会被大声拒绝。`resolveConfig` 抛出带点号路径的 `ConfigError`；插件的 `apply`
捕获它、记录日志，并继续使用 `balanced` 预设，而不是让启动失败。

### 你能拿到多少历史

三个跨度，都有界，都可配置：

| 跨度 | 位置 | 默认 | 回答什么 |
| --- | --- | --- | --- |
| 原始样本 | `windows.rawMs` | 30 分，若最长的 `windowsMs` 更长则抬高到该值 | 分位数、斜率、连续处于某个 band 的时长。 |
| 聚合桶 | `windows.aggregateRetentionMs`、`aggregateBucketMs` | 24 小时、5 分钟桶 | 不保留原始点也能看到长跨度变化。 |
| 每日汇总 | `windows.dailyRetentionMs` | 14 天 | “上周二比今天更糟吗？”—— 每个指标每天一个 `{count, mean, max, min}`。 |

每日汇总是按需从聚合桶上卷得到，因此它的成本与桶的数量成正比，而不是与 uptime 成正比。它们会
出现在每一份 `HealthSnapshot` 的 `dailySummaries` 上，以及 JSON 载荷的 `daily_summaries` 里，
并且以本地午夜为界冻结，因此跨夏令时的一天仍然可比。

## 预设

三个预设都从中性的 `balanced` 文档出发，且只在四处不同。`src/core/presets.ts` 里的
`PRESET_SCALES` 就是全部内容：

```ts
conservative: { bands: 0.85, cooldown: 1.5, maintenance: 0.85 }
balanced:     { bands: 1,    cooldown: 1,   maintenance: 1 }
aggressive:   { bands: 1.15, cooldown: 0.7, maintenance: 1.3 }
```

`scalePreset` 把阶梯的每个 `enter` **和** `exit` 都乘以 `bands`，因此滞回宽度保持成比例而不是
被压平；把三个冷却乘以 `cooldown`；把 `maxDeferMs`、`minStateDwellMs` 与 `minRepeatActionMs`
乘以 `maintenance`。`urgentOverridePressure` 被**除以** `bands`，因此更低压力的机器会更早视压力
为紧急。缩放后的阈值被钳制进 `1 … 99`。

| 字段 | conservative | balanced | aggressive |
| --- | --- | --- | --- |
| `thresholds.throttle` 进入 / 退出 | 47 / 38 | 55 / 45 | 63 / 52 |
| `thresholds.pause_new_work` 进入 / 退出 | 60 / 51 | 70 / 60 | 81 / 69 |
| `thresholds.request_app_restart` 进入 / 退出 | 68 / 58 | 80 / 68 | 92 / 78 |
| `thresholds.request_system_reboot` 进入 / 退出 | 81 / 72 | 95 / 85 | 99 / 98 |
| `cooldowns.throttleMs` | 7.5 分 | 5 分 | 3.5 分 |
| `cooldowns.maintenanceMs` | 45 分 | 30 分 | 21 分 |
| `cooldowns.escalationMs` | 90 分 | 60 分 | 42 分 |
| `maintenance.maxDeferMs` | 51 分 | 60 分 | 78 分 |
| `maintenance.urgentOverridePressure` | 108 | 92 | 80 |
| `antiFlap.minStateDwellMs` | 102 秒 | 120 秒 | 156 秒 |
| `antiFlap.minRepeatActionMs` | 8.5 分 | 10 分 | 13 分 |

注意预设保留的是每个滞回带的**相对**宽度，而不是把它压平；同时进入阈值被限制在 99 以内，以免
某一级被按比例缩放到够不着的地方：压力不存在 100 以上的值，所以 109 这样的进入阈值会静默地删掉
那一级。在 `aggressive` 下 `REQUEST_SYSTEM_REBOOT` 需要模型完全饱和（进入 99、退出 98），这
正是该预设应有的「只在真正吃紧时才用」的行为。指标表本身（每个 band、`sustainMs` 与趋势点数）
在三个预设中完全相同。

三个预设也以 JSON 形式发布在 [`presets/`](presets/) 下，便于 diff，并附带整份配置文档的
JSON Schema。

## 能力与降级

插件会降级，但不会失败。以下每一种都是正常且有类型的结果。

| 情况 | 会发生什么 |
| --- | --- |
| 未安装 `dsh-restart` | `UnavailableRestartAdapter` 报告 `capability: 'unavailable'`。监控与节流继续。重启决策被降级为 `PAUSE_NEW_WORK`，理由 `restart_capability_unavailable`。 |
| 没有绑定 worker-control 服务 | `UnavailableWorkerControlAdapter` 报告 `unavailable`。`THROTTLE` 尝试返回 `applied: false` 并附说明；本拍继续。 |
| 某个 provider 抛异常 | 只有该 provider 被禁用，按指数退避（`providerBackoffMs * 2^steps`，上限 `providerBackoffMaxMs`，在连续失败达到 `providerFailureLimit` 后开始）。它的指标停止到达并变成 `unknown`。 |
| provider 返回 `degraded: true` | 它**确实**测到的指标仍然是权威值；note 会出现在快照的 `warnings` 里。 |
| 传感器不存在 | 该指标键被省略。维度可能变成 `unknown`，coverage 下降，理由列表会说明。 |
| stats 文件尚不存在 / 已过期 | 什么都不报告，并附一条指出所查找路径的 detail；过期文件的内容被拒绝，样本以过期 detail 标记为 degraded。 |
| 配置的辅助命令失败或超时 | 探测错误被报告为 degraded 样本；已测到的指标保留。 |
| 决策日志不可写 | `DecisionLog` 记录失败次数并通过 `lastError` 暴露；调度器继续走。 |
| 未注册安全点源 | `foldReadiness` 返回 `safe: null`。在 `safePointRequired: true` 下重启请求被以理由 `safe_point_unknown` 阻止 —— 没有回答不等于 `yes`。抛异常或挂起的源会在每个源 1 秒预算后贡献一条 `unknown` 读数。 |
| 设置服务或工具运行时缺失 | 记录一条警告，插件仅靠 bundle patch 运行，或不注册任何工具。用户文档导致的 `ConfigError` 会被记录，并改用 `balanced` 预设，而不是让启动失败。 |

## Provider 遥测矩阵

默认注册七个 provider id。**请认真看这张表**：设计中的大多数指标没有原生来源，而插件会如实说明，
而不是猜。

| Provider id | 原生可测 | 需要外部接缝 | 说明 |
| --- | --- | --- | --- |
| `hardware` | `cpu_usage` | `cpu_temp_c`、`gpu_temp_c`、`gpu_usage`、`thermal_throttle`、`power_limit_hit` | `cpu_usage` 是 `os.cpus()` 时间计数器的真实差分，不需要任何特权。`gpu_usage` **不是**原生的 —— 这里没有 GPU 计数器。五个热指标全部通过 `providerOptions.hardware.helperCommand` 或 stats 文件到达。 |
| `memory` | `ram_total_bytes`、`ram_available_bytes`、`ram_used_ratio`、`process_rss_bytes` | `commit_used_ratio`、`process_private_bytes`、`vram_used_ratio` | 来自 `os.totalmem()`、`os.freemem()` 与进程 RSS。只有当平台辅助程序提供了 `treeRssBytes` 时，`process_rss_bytes` 才是**进程树**；否则它是本进程的 RSS。 |
| `runtime` | `uptime_seconds`；当运行时暴露 `process.getActiveResourcesInfo()` 时的 `handle_count` | `event_loop_latency_ms`、`worker_process_count`、`thread_count`、`restart_count`、`ipc_timeout_rate`；来自心跳文件的 `heartbeat_delay_ms` | 中间五个指标来自注入的 `RuntimeFeed`。插件自己的入口传入 `EMPTY_RUNTIME_FEED`，它对一切都回答 `null` —— 所以没有集成时它们**永远是 unknown**。`handle_count` 数的是 libuv handle 加 timeout，不是操作系统 handle。 |
| `workers` | 无 | `active_workers`、`queued_tasks`、`task_latency_ms`、`timeout_rate`、`retry_rate`、`failure_rate`、`spawn_failure_rate`、`abnormal_exit_rate`、`queue_delay_ms` | stats 文件或 `providerOptions.statsFile.commands`。插件不插桩 worker 内部。 |
| `computer-use` | 无 | `screenshot_latency_ms`、`action_latency_ms`、`verification_retry_rate`、`missed_target_rate`、`recovery_rate`、`desktop_responsiveness_ms` | stats 文件或命令探测。`providerOptions.computerUse` 已声明但尚未接到任何探测上。 |
| `ui` | 无 | `render_latency_ms`、`main_window_heartbeat_ms`、`blank_frame_rate`、`frontend_error_rate` | stats 文件或命令探测，由 Web 客户端遥测写入。 |
| `context` | 无 | `task_failure_rate`、`git_operations_per_minute` | stats 文件或命令探测。 |

两个必须直说的后果：在没有任何 helper、stats 文件与集成的默认安装上，只有 `cpu_usage`、三个
RAM 比率和 `uptime_seconds` 有值，而报告会说明 coverage 很低。以及，**CPU/GPU 温度不是原生测量
的** —— 本插件内部没有 NVML、没有 WMI、没有 LibreHardwareMonitor 绑定。可用 PowerShell 辅助
程序示例见
[docs/configuration.zh.md](docs/configuration.zh.md#在-windows-上读取-gpu-温度)。

## 尚未实现 / 路线图

以下内容在 `0.1.0` 中是如实缺席的，而不是半成品。

- **`./startup` 子路径导出指向未构建的文件。** `package.json` 把 `./startup` 导出为
  `./lib/startup.js` 与 `./lib/types/startup.d.ts`；但不存在 `src/startup.ts`，因此该子路径
  无法解析。包内没有任何东西导入它，bundle patch 也不使用它，所以实际影响是一个死导出，而不是
  安装失败。
- **没有 UI 页面。** 设计稿里的 Health 页面没有实现。它需要的每个字段 —— 压力、逐维度表、逐指标
  数值、维护、就绪度、能力、provider 状态、趋势、最近决策与每日汇总 —— 都在 `HealthSnapshot`
  与 `metricsSnapshot()` 的 JSON 里，但没有任何 client 插件渲染它。
- **`providerOptions.memory.extraPids` 覆盖的是整个 launcher 进程树，而不只是本进程。**
  求和在后台从平台进程列表刷新，因此单独启动的 worker 里的泄漏也会出现在 `process_rss_bytes` 中。
- **长跨度趋势改由聚合桶拟合。** 当请求的跨度比 `windows.rawMs` 更久远时，`TrendAnalyzer` 改为
  拟合保留的桶均值而不是原始样本，并在趋势摘要里写明所用序列（`aggregate buckets`）。因此原始
  跨度只有 6 小时的机器也能看见 24 小时的泄漏。
- **长跑测试层没有实现。** 设计稿要求 6 小时 / 12 小时合成与 24 小时真机 soak；仓库里只有单元、
  插件、调度器与合成场景测试。最接近的是那个 30 分钟、120 次评估的决策风暴上界。
- **`git_operations_per_minute` 没有消费者。** 它被采集、被放在 `time` 维度、权重为 `0.5`，但
  既无 band 又无趋势项，因此不贡献任何分数，也还没有任何东西把它当作安全点的忙碌信号。
- **`escalation_requested_at_maximum_pressure` 陈述的是条件而非历史。** 引擎没有能让上一次应用
  重启回传结果的通道，因此这个理由描述的是压力当前的形态，而不是宣称之前有重启失败过。的 patch。

## 文档索引

| 文档 | English | 中文 |
| --- | --- | --- |
| 规范指标注册表：单位、极性、边界、默认 band、持续时间、来源 provider | [docs/metrics.md](docs/metrics.md) | [docs/metrics.zh.md](docs/metrics.zh.md) |
| 压力模型：维度、爬升、`WORST_WEIGHT`、趋势、coverage、算例 | [docs/pressure-model.md](docs/pressure-model.md) | [docs/pressure-model.zh.md](docs/pressure-model.zh.md) |
| 动作阶梯、防抖、冷却、分派、安全点、维护阶段 | [docs/policies.md](docs/policies.md) | [docs/policies.zh.md](docs/policies.zh.md) |
| 每个配置键、stats 文件格式、命令探测格式 | [docs/configuration.md](docs/configuration.md) | [docs/configuration.zh.md](docs/configuration.zh.md) |
| 验收标准与设计场景到具名测试的映射 | [docs/acceptance.md](docs/acceptance.md) | [docs/acceptance.zh.md](docs/acceptance.zh.md) |
| 预设文档与生成的 JSON Schema | [presets/README.md](presets/README.md) | — |
| 发布历史 | [CHANGELOG.md](CHANGELOG.md) | — |
| 如何贡献与引擎的诚实规则 | [CONTRIBUTING.md](CONTRIBUTING.md) | — |
| 威胁模型与负责任披露 | [SECURITY.md](SECURITY.md) | — |

## 开发

```sh
npm install                # 只装开发依赖；插件没有运行时依赖
npm run build              # tsc -p tsconfig.json -> lib/
npm test                   # npm run build && node --test tests/*.test.js
npm run test:only          # node --test tests/*.test.js，使用现有 lib/
npm run typecheck          # tsc -p tsconfig.json --noEmit
npm run presets            # 从 lib/ 重新生成 presets/*.json
npm run verify:artifacts   # 校验构建产物与预设彼此一致
```

值得了解的 TypeScript 设置：`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、
`noUnusedParameters`、`verbatimModuleSyntax`、`target: ES2023`、`module: NodeNext`。引擎
（`src/core`、`src/types`、`src/providers`、`src/adapters`、`src/audit`）**不依赖 harness**；
只有 `src/dsh/` 知道 Cordis，而且是通过 `src/dsh/context.ts` 里那些窄结构接口知道的。这正是整个
引擎无需运行时即可测试的原因。

测试套件共 148 个测试、分布在 8 个文件中，按提交状态全部通过：

```sh
node --test tests/*.test.js
# tests 148 / suites 27 / pass 148 / fail 0
```

```sh
node scripts/generate-presets.mjs --check
# ok   presets/balanced.json matches PRESETS.balanced
# ok   presets/conservative.json matches PRESETS.conservative
# ok   presets/aggressive.json matches PRESETS.aggressive
# ok   presets/schema.json matches the configuration schema
# ok   4 generated files are up to date
```

## 常见问题

**它会重启我的机器吗？**
不会，它做不到。本插件里完全没有重启执行 —— 没有 `taskkill`、没有 `reboot`、没有杀进程。第 3、
4 级只产出一个 `RestartRequest` 对象，交给 context 上的任意 `RestartAdapter`。没有安装
`dsh-restart` 时该适配器报告 `unavailable`，请求被降级为 `PAUSE_NEW_WORK`。

**温度传感器缺失会怎样？**
该指标直接不出现在样本里。`cpu_temp_c` 与 `gpu_temp_c` 从不原生测量，所以在默认安装上除非你配置
辅助命令或 stats 文件，它们永远缺席。此时热维度只对它有数据的东西打分（`cpu_usage`，以及辅助
程序提供的任何值）；如果一个都没有，它就是 `unknown`，coverage 下降，报告把它列在
`Unknown dimensions: … (not scored as healthy)` 之下。它永远不会被打成 `0`。

**为什么我的压力是 0，状态却是 `DEGRADED`？**
因为它们回答的是不同的问题。压力高于节流**退出**带时 `restart_pressure` 可以是 0 —— 状态机把
这种情形叫 `DEGRADED` 而不是 `HEALTHY`。反过来，`pressure: null`（什么都测不到）同样刻意给出
`DEGRADED`：未知不是健康。决策记录上的理由列表会指出是哪个门禁拦住了它。

**怎么把它关掉？**
三种方式，越来越彻底。在插件配置里设 `enabled: false` —— 它仍然加载、仍然注册命名空间与工具，
但不采集、不启动循环。或者用 `disabledProviders: ["hardware"]` 关掉个别 provider。或者用
`dsh plugin --profile web remove dsh-health-scheduler` 从 profile 里彻底移除，这也会把它从
profile 的 bundle 列表里去掉。卸载不影响 DS-Hns。

**它占用多少磁盘？**
几乎不占，而且是有界的。决策日志是 `<DSH_HOME>/health-scheduler`（或 `storage.directory`）下的
一个 `decisions.jsonl`，超过 `storage.maxLogBytes` 时按重命名轮转 —— 默认 4 MiB，所以最坏情况
是连同旁边一个 `.bak` 约 8 MiB。别的什么都不写：滚动历史在内存里，受 `windows.rawMs` 与
`windows.aggregateRetentionMs` 约束。`storage.enabled: false` 会让插件变成纯内存模式。

**怎么加自定义传感器？**
写进 stats 文件，或暴露为命令探测。两者都使用规范指标词表，非规范键会被报告而不是被静默丢弃。
如果你的传感器确实是新的，就必须扩展规范注册表 —— provider 只能上报存在于
`src/types/metrics.ts` 中的名字。见
[docs/configuration.zh.md](docs/configuration.zh.md#添加自定义传感器)。

**它会和 `dsh-restart` 打架吗？**
打不起来，因为它无法行动。它投递一个带调用方自选 `requestId` 的 `RestartRequest`，并读回
`accepted` / `rejected` 以及重启侧的生命周期状态。锁、限流、checkpoint token 与崩溃循环熔断都
属于 `dsh-restart`；本插件的冷却只约束**它自己**的请求，而且被拒绝会启动冷却而不是立刻重试。
卸载 `dsh-restart` 后监控与节流仍然完整可用。

**需要管理员权限吗？**
不需要。它读取 `os.cpus()`、`os.totalmem()`、`os.freemem()`、`process.memoryUsage()`、
`process.uptime()` 以及（可用时的）`process.getActiveResourcesInfo()`，读取并 stat 文件，
以及可选地运行你配置的辅助命令。你把它指向需要特权的辅助程序时，它继承的是**你的**权限 —— 那是
你的选择，而不是插件的要求；插件自己从不提权。

**为什么 coverage 只有 60%？**
因为六个维度里只有四个有遥测。coverage 是被真实测量支撑的名义权重占比。没有集成时，除 uptime
以外的 `runtime` 指标、所有 `worker` 指标、所有 `computer_use_ui` 指标都没有来源，因此在
hardware 与 memory 在上报时 coverage 就在 0.6 附近。这正是功能在正常工作：60% coverage 的压力
被如实标注，而不是假装成满置信读数。

**它会让我的机器变慢吗？**
默认每 15 秒一拍，而且每拍都很便宜：几次 `os` 调用、最多每 2 秒一次的 stats 文件读取，以及每个
已配置探测最多一次辅助命令。滚动内存由构造方式保证有界，所以不会有任何东西随 uptime 增长。它能
做的最重的事情是**你**配置的辅助命令，它在你设定的超时下运行（`helperTimeoutMs`，默认 5 秒）。

## 许可证

MIT © 2026 dsh-health-scheduler contributors。见 [LICENSE](LICENSE)。

这是一个**社区插件**。它与 DeepSeek 无隶属关系，也未获得 DeepSeek 的赞助或背书。
“DeepSeek Harness”与“DS-Hns”仅用于描述它所集成的对象。

安装插件意味着**以你的权限**运行第三方代码 —— 本插件也不例外。在把它装进一个能触达生产凭据或
无人值守机器的 profile 之前，请先阅读 [SECURITY.md](SECURITY.md)。
