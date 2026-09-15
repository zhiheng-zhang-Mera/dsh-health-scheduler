# Preset documents

Machine-readable copies of the three presets shipped by `dsh-health-scheduler`:
[`balanced.json`](./balanced.json), [`conservative.json`](./conservative.json) and
[`aggressive.json`](./aggressive.json).

Each file is the exact value of the matching TypeScript constant — `PRESETS.balanced`,
`PRESETS.conservative`, `PRESETS.aggressive` — with every default already filled in. One field is
normalized once more at load time: `windows.rawMs` is a floor rather than a cap, so `resolveConfig()`
raises it to the longest statistics window (6 h = `21600000`) whenever the configured floor is
shorter. The files keep the declared 30-minute floor (`1800000`), which is the value `PRESETS`
carries and a perfectly valid document to hand to the plugin.
The three preset files and `presets/schema.json` are generated from the build output
(`lib/core/presets.js`, `lib/types/metrics.js`) by `scripts/generate-presets.mjs`; edit
the TypeScript, not the JSON. `presets/schema.json` is a JSON Schema (draft 2020-12) for
a whole plugin configuration document: its metric enum comes from the canonical metric
registry and its constraints mirror the checks the runtime validator in
`src/core/config.ts` performs.

## What each preset changes

All three documents start from the neutral `balanced` base and differ in exactly four
places: the action ladder (`thresholds`), the self-imposed cooldowns, the maintenance
deferral and urgent-override values, and the anti-flap dwell floors. Everything else —
`sampling`, `windows`, `trend`, `weights`, `metrics`, `throttle`, `resilience`,
`storage`, `disabledProviders`, `providerOptions` — is identical in all three files.

| Field | conservative | balanced | aggressive |
| --- | --- | --- | --- |
| `thresholds.throttle` enter / exit | 47 / 38 | 55 / 45 | 63 / 52 |
| `thresholds.pause_new_work` enter / exit | 60 / 51 | 70 / 60 | 81 / 69 |
| `thresholds.request_app_restart` enter / exit | 68 / 58 | 80 / 68 | 92 / 78 |
| `thresholds.request_system_reboot` enter / exit | 81 / 72 | 95 / 85 | 99 / 98 |
| `cooldowns.throttleMs` | 7.5 min | 5 min | 3.5 min |
| `cooldowns.maintenanceMs` | 45 min | 30 min | 21 min |
| `cooldowns.escalationMs` | 90 min | 60 min | 42 min |
| `maintenance.maxDeferMs` | 51 min | 60 min | 78 min |
| `maintenance.urgentOverridePressure` | 108 | 92 | 80 |
| `antiFlap.minStateDwellMs` | 102 s | 120 s | 156 s |
| `antiFlap.minRepeatActionMs` | 8.5 min | 10 min | 13 min |

- **`balanced`** (the default) is the neutral document: throttle at pressure 55,
  pause new work at 70, request an app restart at 80, request a system reboot at 95,
  with a 5/30/60-minute cooldown ladder.
- **`conservative`** scales the ladder by `0.85`, the cooldowns by `1.5` and the
  maintenance/anti-flap dwell times by `0.85`, so the plugin reacts to lower pressure,
  then waits longer before acting again and demands more pressure (108) to override a
  maintenance window. Use it on a machine that must stay up, or while tuning.
- **`aggressive`** scales the ladder by `1.15`, the cooldowns by `0.7` and the
  maintenance/anti-flap dwell times by `1.3`, so it tolerates more pressure before it
  acts, acts again sooner, and treats a lower pressure (80) as urgent enough to
  override the window. Use it on a machine that is expected to be recycled.
- In all three presets the `exit` value is scaled by the same band factor as `enter`,
  so hysteresis stays proportional to the ladder; the metric table itself (bands,
  `sustainMs`, trend points) is never touched by a preset.

## How to apply a preset

**Set the preset by name** in the plugin configuration. It is a partial document, so
any explicit leaf you write next to it still wins over the preset:

```json
{ "preset": "conservative" }
```

```yaml
# cordis.patch.yml, in the plugin's config row
- name: dsh-health-scheduler
  config:
    preset: conservative
```

**Or copy a file and pass it as the plugin configuration document.** Every file here is
a complete, valid configuration, so nothing has to be merged by hand:

```bash
cp presets/conservative.json health-scheduler.config.json
```

A copied file freezes the values it contains at the moment you copy it; re-copy it after
upgrading the plugin if you want the new defaults. The `preset` field inside the copy
still names the preset it came from, so reports and settings stay truthful.

## Regenerating

```bash
npm run build                          # presets are read from lib/, never from src/
npm run presets                        # rewrite presets/*.json and presets/schema.json
node scripts/generate-presets.mjs --check   # assert the checked-in files are current
```

`--check` writes nothing and exits non-zero when a file is missing or stale, which makes
it safe to wire into CI.

---

# 预设文档

本目录是 `dsh-health-scheduler` 三个内置预设的机器可读副本：
[`balanced.json`](./balanced.json)、[`conservative.json`](./conservative.json)、
[`aggressive.json`](./aggressive.json)。

每个文件都是对应 TypeScript 常量的精确取值（`PRESETS.balanced`、`PRESETS.conservative`、
`PRESETS.aggressive`），所有默认值均已填好。只有一个字段会在加载时被再次规范化：
`windows.rawMs` 是下限而非上限，因此当配置的下限更短时，`resolveConfig()` 会把它提升到最长的
统计窗口（6 小时 = `21600000`）。文件中保留声明值 30 分钟（`1800000`），这既是 `PRESETS`
实际携带的取值，也是可以放心交给插件的合法配置。
三个预设文件与 `presets/schema.json` 均由
`scripts/generate-presets.mjs` 从构建产物（`lib/core/presets.js`、`lib/types/metrics.js`）
生成，请修改 TypeScript 而不是 JSON。`presets/schema.json` 是整份插件配置文档的 JSON Schema
（draft 2020-12）：其中的指标枚举来自规范指标注册表，其约束与 `src/core/config.ts` 中运行时
校验器实际执行的检查一致。

## 各预设改变了什么

三个文档都以中性的 `balanced` 为基础，只有四处不同：动作阶梯（`thresholds`）、自我冷却
（`cooldowns`）、维护推迟与紧急覆盖值、以及防抖（反抖动）驻留下限。其余部分
（`sampling`、`windows`、`trend`、`weights`、`metrics`、`throttle`、`resilience`、`storage`、
`disabledProviders`、`providerOptions`）在三份文件中完全相同。

| 字段 | conservative | balanced | aggressive |
| --- | --- | --- | --- |
| `thresholds.throttle` 进入 / 退出 | 47 / 38 | 55 / 45 | 63 / 52 |
| `thresholds.pause_new_work` 进入 / 退出 | 60 / 51 | 70 / 60 | 81 / 69 |
| `thresholds.request_app_restart` 进入 / 退出 | 68 / 58 | 80 / 68 | 92 / 78 |
| `thresholds.request_system_reboot` 进入 / 退出 | 81 / 72 | 95 / 85 | 99 / 98 |
| `cooldowns.throttleMs` | 7.5 分钟 | 5 分钟 | 3.5 分钟 |
| `cooldowns.maintenanceMs` | 45 分钟 | 30 分钟 | 21 分钟 |
| `cooldowns.escalationMs` | 90 分钟 | 60 分钟 | 42 分钟 |
| `maintenance.maxDeferMs` | 51 分钟 | 60 分钟 | 78 分钟 |
| `maintenance.urgentOverridePressure` | 108 | 92 | 80 |
| `antiFlap.minStateDwellMs` | 102 秒 | 120 秒 | 156 秒 |
| `antiFlap.minRepeatActionMs` | 8.5 分钟 | 10 分钟 | 13 分钟 |

- **`balanced`**（默认）是中性的基准文档：压力 55 节流、70 暂停新任务、80 请求重启应用、
  95 请求重启系统，冷却阶梯为 5 / 30 / 60 分钟。
- **`conservative`** 将阶梯乘以 `0.85`、冷却乘以 `1.5`、维护与防抖驻留时间乘以 `0.85`：
  更低的压力就会触发动作，动作后等待更久，且需要更高压力（108）才覆盖维护窗口。适合
  不能中断的机器，或调参阶段。
- **`aggressive`** 将阶梯乘以 `1.15`、冷却乘以 `0.7`、维护与防抖驻留时间乘以 `1.3`：
  能容忍更高压力才动作、更快再次动作，并以更低压力（80）视为紧急而覆盖维护窗口。适合
  本来就计划定期回收的机器。
- 三个预设中 `exit` 与 `enter` 使用同一个倍数，因此滞回宽度随阶梯成比例变化；预设从不
  改动指标表本身（band、`sustainMs`、趋势点数）。

## 如何应用某个预设

**在插件配置中按名称选择预设。** 它是部分文档，因此你在旁边显式写下的任何叶子值都会
覆盖预设：

```json
{ "preset": "conservative" }
```

```yaml
# cordis.patch.yml 中该插件的 config 行
- name: dsh-health-scheduler
  config:
    preset: conservative
```

**或复制文件并作为插件配置文档传入。** 这里的每个文件都是完整且合法的配置，无需手工合并：

```bash
cp presets/conservative.json health-scheduler.config.json
```

复制出来的文件会把其中的数值固定在复制那一刻；升级插件后如需采用新默认值，请重新复制。
副本中的 `preset` 字段仍标明其来源预设，因此报告与设置界面不会失真。

## 重新生成

```bash
npm run build                          # 预设只从 lib/ 读取，绝不读 src/
npm run presets                        # 重写 presets/*.json 与 presets/schema.json
node scripts/generate-presets.mjs --check   # 校验已提交的文件是否为最新
```

`--check` 不写入任何文件，文件缺失或过期时以非零状态退出，可安全接入 CI。
