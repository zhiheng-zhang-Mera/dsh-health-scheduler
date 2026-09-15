# Contributing to `dsh-health-scheduler`

Thanks for considering a contribution. This project has an unusual constraint for a health
monitor — it is **forbidden from acting** — and most of the review guidance below exists to keep
that property true.

## Getting set up

```sh
npm install              # dev dependencies only; the plugin has no runtime dependencies
npm run build            # tsc -p tsconfig.json -> lib/
npm test                 # npm run build && node --test tests/*.test.js
npm run test:only        # node --test tests/*.test.js, against the existing lib/
npm run typecheck        # tsc -p tsconfig.json --noEmit
npm run presets          # regenerate presets/*.json from lib/
npm run verify:artifacts # assert the built artifacts, the registry and the presets are coherent
```

Requirements: Node `>= 20.11.0` and TypeScript `^5.7`. The tests import from `lib/`, not from
`src/`, so `npm test` builds first and `npm run test:only` is the fast loop once you have built
once. `npm run verify:artifacts` is cheap and is worth running before a commit that touches
`src/types/metrics.ts`, `src/core/presets.ts` or the package entry.

The committed suite is 148 tests across eight files:

```sh
node --test tests/*.test.js
# tests 148 / suites 27 / pass 148 / fail 0
```

### Regenerating the preset documents

```sh
npm run presets                              # rewrite presets/*.json and presets/schema.json
node scripts/generate-presets.mjs --check     # verify they are current; exits non-zero when stale
```

Both the script and the npm alias exist. If you change a preset, a default or the metric
registry, regenerate the documents in the same commit — `--check` fails otherwise, and the
checked-in JSON is what an operator diffs.

## The rules that are not negotiable

These come from the design document and they are the reason the plugin is trustworthy. A pull
request that breaks one of them will be declined, however good the code is.

### 1. This plugin never restarts anything

No `taskkill`, no process kill, no `reboot`, no `shutdown`, no OS restart API, no library that
wraps one. Restart execution belongs to `dsh-restart`; relaunch and crash-loop breaking belong
to the supervisor; task state, checkpoints and resume belong to DS-Hns Core.

Concretely:

- A new action that leaves the process must go through an adapter in `src/adapters/types.ts`.
- `src/core/**` must not import `node:child_process`, `node:fs` for writing, or any platform
  API. The one permitted `execFile` is `runCommandProbe` in `src/providers/sources.ts`, and it
  exists to run a **user-configured telemetry probe**, not to act on the system.
- The scheduler must not modify worker queues, task state or harness internals. `THROTTLE` and
  `PAUSE_NEW_WORK` are *requests* to a `WorkerControlAdapter`.

### 2. Never report unknown as healthy

- A provider that cannot measure a metric omits the key. It does not report `0`, `-1` or a
  sentinel.
- A dimension with no known metric scores `null`, not `0`.
- A metric with no data scores `null`, and `levelOf(null)` is `'unknown'`, which is distinct
  from `'none'`.
- An unanswered safe-point question is `null`, never `true`.
- If you add a code path that has to choose between "I do not know" and "it is fine", it must
  choose "I do not know" and it must say so in the reason list.

### 3. Never let a single sample drive a high-risk action

- A scored metric passes a sustain gate before its score counts.
- Every decision reads rolling statistics, not a point.
- Levels 3 and 4 are debounced, gated on the maintenance window and gated on a safe point.
- Anti-flapping is not optional: if you add a new transition, make sure hysteresis, dwell and
  the cooldown buckets still apply to it.

### 4. Every decision must be explainable

A decision is a pressure number, a state, a list of named drivers with concrete values, and a
list of reusable reason strings. "The model thought it should restart" is not a reason and must
never become one. If you add a reason string, add the prefix to `REASONS.prefixes` in
`tests/helpers/drive.js` and assert on it.

### 5. The engine stays framework-free

`src/core`, `src/types`, `src/providers`, `src/adapters` and `src/audit` must not import
Cordis, `@deepseek-ai/*` or anything else from the harness. Only `src/dsh/**` may, and it must
go through the narrow structural interfaces in `src/dsh/context.ts` rather than the harness's
own types. That is what lets the whole engine be tested with no runtime.

If you need a new capability from the host, add it to `HarnessContextLike` as an optional
member and handle its absence at runtime. A missing service is a runtime fact, not a type error.

### 6. Do not build a second observability platform

The plugin answers "is the system degrading, and what should happen next?" — nothing else. It
keeps a bounded decision log and bounded rolling history. It does not add per-sample
persistence, an export pipeline, a metrics endpoint, a dashboard backend or an unbounded cache.
New disk writes need a bounded size in `storage` and a documented rotation or retention rule.

When you add a new horizon, add it to the three that already exist rather than inventing a
fourth store: raw samples (`windows.rawMs`), aggregate buckets
(`windows.aggregateRetentionMs`) and daily summaries (`windows.dailyRetentionMs`). Every one of
them is bounded by a duration, and none of them grows with uptime. If your feature needs a
fourth, say in the pull request why the existing three cannot carry it.

## Adding a provider

1. Implement `HealthProvider` from `src/types/provider.ts`:

   ```ts
   interface HealthProvider {
     readonly id: string
     readonly group: ProviderGroup
     readonly provides: readonly CanonicalMetric[]
     readonly enabled?: boolean
     sample(): Promise<HealthSample> | HealthSample
   }
   ```

2. **`sample()` must be cheap and non-blocking.** It reports a measurement, it does not perform
   one. A provider that needs an asynchronous probe keeps a cached value that a background
   probe refreshes and returns the cache.
3. **Never throw for mere data absence** — omit the metric. Throw only for a genuine failure;
   the registry will contain it and back the provider off.
4. **Use `degraded: true` with a `degradedReason`** from `DegradedReason` when the provider ran
   but could not measure everything. The metrics it *did* measure stay authoritative. Put
   anything a human needs to know in `note`; it is surfaced in the snapshot's warnings and is
   never used for scoring.
5. **Register it** in `registerBuiltInProviders` in `src/dsh/plugin.ts`, honour
   `disabledProviders`, and add a corresponding `providerOptions` block if it has options.
6. **Add it to the tables** in `README.md`, `README.zh.md`, `docs/metrics.md` and
   `docs/metrics.zh.md`. The provider telemetry matrix in both READMEs must stay honest about
   what is native and what needs an external seam.
7. **Test it.** There is no provider-level test harness yet; `tests/helpers/rig.js` registers
   scripted providers, and `ProviderEnvironment` (`src/providers/environment.ts`) is the seam
   that makes a real provider testable without a real machine. Use it.

## Adding a metric

1. Add the name to the `CanonicalMetric` union in `src/types/metrics.ts`.
2. Add a descriptor to `METRICS`; `satisfies Record<CanonicalMetric, MetricDescriptor>` will
   force you to. Decide carefully:
   - `unit` — one physical quantity, one unit.
   - `polarity` — which direction is worse. This is what makes a declining `recovery_rate` read
     as a problem, so get it right rather than relying on band ordering.
   - `group` — the subsystem that owns it.
   - `hardMin` / `hardMax` — only where physics justifies them. `process_rss_bytes` has no
     maximum for a reason.
3. Add a default entry to `DEFAULT_METRIC_CONFIG` in `src/core/presets.ts` if it should be
   scored. A metric with neither a band nor a trend term is collected and never scored, which is
   a legitimate choice but should be a deliberate one.
4. Map it in `METRIC_DIMENSION` in `src/core/pressure.ts`. `dimensionOf()` falls back to
   `runtime`, so missing this is silent.

   **Remember that the registry group and the pressure dimension are different things.**
   `task_failure_rate` is in the `context` group and feeds the `worker` dimension;
   `git_operations_per_minute` is in `context` and feeds `time`. Do not double-count a metric
   into two dimensions.
5. Add it to a provider's `provides` list.
6. Rebuild and test. `tests/normalization.test.js` asserts that every canonical name has a
   descriptor, that the registry keys stay sorted and unique, and that the vocabulary has at
   least 40 entries.
7. Document the new row in `docs/metrics.md` **and** `docs/metrics.zh.md`, including unit,
   polarity, bounds, default band, sustain time and source provider.
8. If it has a trend term, add a worked value to `docs/pressure-model.md` and
   `docs/pressure-model.zh.md`.

### Choosing a band and a sustain time

- `warn` is where the metric starts to be interesting; `critical` is where it is unambiguously
  bad. A band whose `warn` is already a failing value makes the dimension useless.
- `sustainMs` is the "86 °C for 15 minutes" rule. A metric that is a **fact** rather than a
  sensor reading (`restart_count`) gets `sustainMs: 0`; a temperature or a latency gets at least
  a minute.
- `weight` is relative *within the dimension*. Raising a metric's weight moves both the
  dimension's weighted mean and, indirectly, how much the worst member is diluted.
- `trendPointsPerHour` is normalized by `|critical - warn|`, except for a bandless metric, where
  the reference is treated as `1` and the full points are earned by any trusted slope. That is
  deliberate for the two leak metrics; think twice before copying it.
- `trendCap` defaults to 25. A cap above the band span means the trend can dominate the level,
  which is rarely what you want.

## Adding an action

The ladder is `DECISION_LADDER` in `src/types/config.ts` and `ACTION_LEVEL` in
`src/types/decision.ts`. Adding a rung means touching, at minimum:

- the two constants above,
- `ActionThresholds` and `requireThresholds`,
- `gateRestart` and `stateFor` in `src/core/policy.ts`,
- `cooldownKindOf` for the cooldown bucket,
- `applyAction` in `src/core/scheduler.ts` and the adapter contract if the action leaves the
  process,
- `REASONS.prefixes` and `ACTIONS` in `tests/helpers/drive.js`,
- the ladder table in `docs/policies.md`, `docs/policies.zh.md`, both READMEs and
  `presets/README.md`.

An action that performs a restart itself is not eligible, no matter how it is shaped.

## Testing expectations

- **Use the rig.** `ScenarioRig` gives you an injectable clock, scripted providers, recording
  adapters and a scriptable safe point. `rig.advance(ms, steps)` is how you write "20 minutes of
  88 °C" in one line. `drive(rig, { minutes, tickMs, maintenanceWindow, onTick })` is the longer
  form.
- **State the acceptance criterion in the test.** The scenario tests open with the promise being
  encoded, so a failure names the promise that broke rather than the number that moved.
- **Do not test the clock.** `HealthScheduler` takes `clock` and `PolicyEngine` takes `nowMs`;
  there is no reason for a test to sleep.
- **Assert on reasons, not only on numbers.** A test that asserts `pressure > 35` will survive a
  change that stops explaining itself; a test that asserts a reason prefix will not.
- **Add a scenario test for anything that changes the decision path**, and prefer extending
  `tests/scenarios.test.js`'s invariant suite over adding a new one-off.
- **Keep the suite fast.** The whole thing runs in under five seconds. If a test needs a long
  simulated period, that is a loop over injected ticks, not a real wait.

## Style

- TypeScript `strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`,
  `verbatimModuleSyntax`. `npm run typecheck` must be clean.
- ES modules with `.js` extensions in relative import specifiers (`NodeNext` resolution).
- Prefer `readonly` on interface members, `Object.freeze` on exported tables, and `satisfies`
  over casts.
- Every module starts with a `@module` doc comment explaining **why** it exists, not what its
  functions are called. Match the surrounding density: this codebase documents intent, not
  syntax.
- Comments that explain a non-obvious decision are welcome and expected. Comments that restate
  the next line are not.
- Errors that a user can act on must name the offending value and its dotted path; see
  `ConfigError`.
- Use US spelling in identifiers, comments and prose, matching the existing codebase:
  `normalize`, `behavior`, `serialize`, `color`. Do not mix conventions within a file.

## Docs, both languages

Every user-facing document has an English and a Simplified Chinese version, and they must stay
in step:

| English | 中文 |
| --- | --- |
| `README.md` | `README.zh.md` |
| `docs/metrics.md` | `docs/metrics.zh.md` |
| `docs/pressure-model.md` | `docs/pressure-model.zh.md` |
| `docs/policies.md` | `docs/policies.zh.md` |
| `docs/configuration.md` | `docs/configuration.zh.md` |
| `docs/acceptance.md` | `docs/acceptance.zh.md` |

The Chinese files are **translations, not summaries**: same headings, same tables, same code
blocks, same depth. Numbers, metric names, config keys, file paths, reason codes and test names
are never translated. If you change one language, change the other in the same commit.

## Compatibility

- The plugin must run against any harness release that provides the services it declares. It
  `inject`s `tools` and treats `settings` as optional, so do not add a hard dependency on a
  service without a documented fallback.
- `peerDependencies` are `@deepseek-ai/cordis ^4.0.1`, `@deepseek-ai/dsh-tools
  ^0.1.1-rc.1` and (optional) `@deepseek-ai/dsh-settings ^0.1.1-rc.1`. Widening or narrowing them
  is a breaking change and needs a changelog entry.
- Node `>= 20.11.0`. The code targets `ES2023`; do not use syntax that requires a newer runtime.

## Changelog and versioning

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Because this is a plugin, the
surface that matters for a breaking change is:

- the configuration document shape (removing or renaming a key, changing a default that changes
  behaviour),
- the canonical metric vocabulary (removing or renaming a metric),
- the action ladder, machine states and reason codes,
- the exported library API in `src/index.ts`,
- the three tool names, their parameters and the shape of their output,
- the on-disk decision-log schema (`LOG_SCHEMA_VERSION`).

Add your entry under `## [Unreleased]` in the right category (`Added`, `Changed`, `Deprecated`,
`Removed`, `Fixed`, `Security`) and describe the observable effect, not the internal refactor.

## Reporting bugs

Include:

- the exact `dsh` command and profile you used,
- your configuration document (redact paths you would rather not share),
- the output of `health_status` — ideally the `full` section, which carries coverage, unknown
  dimensions, provider status and the recent decisions,
- Node version, OS and whether `dsh-restart` is installed in that profile,
- which metrics you expected to have values and which reported `unknown`.

A report that says "pressure is wrong" without those is hard to act on; a report that says
"`gpu_temp_c` is unknown and my helper prints `gpu_temp_c=52`" is immediately actionable.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
