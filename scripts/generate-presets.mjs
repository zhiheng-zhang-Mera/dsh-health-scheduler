#!/usr/bin/env node
/**
 * Regenerate the machine-readable documents under `presets/`.
 *
 * The shipped presets are TypeScript constants (`src/core/presets.ts`). This
 * script serialises the *resolved* objects from the build output
 * (`lib/core/presets.js`) so the JSON an operator diffs can never drift from the
 * values the runtime actually uses. It emits:
 *
 *   presets/balanced.json       PRESETS.balanced
 *   presets/conservative.json   PRESETS.conservative
 *   presets/aggressive.json     PRESETS.aggressive
 *   presets/schema.json         JSON Schema (draft 2020-12) for a config document,
 *                               whose metric enum is read from `lib/types/metrics.js`
 *
 * Usage:
 *   npm run presets            # rewrite the four generated files
 *   node scripts/generate-presets.mjs --check
 *                              # verify the checked-in files are up to date
 *                              # (writes nothing, exits non-zero when stale)
 *
 * Run `npm run build` first: this reads `lib/`, never `src/`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const presetsDir = path.join(projectRoot, 'presets')

/** Presets are written in this order; one file per name. */
const PRESET_NAMES = ['balanced', 'conservative', 'aggressive']

const checkOnly = process.argv.includes('--check')

const { PRESETS } = await import(new URL('../lib/core/presets.js', import.meta.url).href)
const { CANONICAL_METRICS } = await import(new URL('../lib/types/metrics.js', import.meta.url).href)

if (PRESETS === null || typeof PRESETS !== 'object') {
  throw new Error('lib/core/presets.js did not export a PRESETS object; run `npm run build` first')
}
if (!Array.isArray(CANONICAL_METRICS) || CANONICAL_METRICS.length === 0) {
  throw new Error('lib/types/metrics.js did not export CANONICAL_METRICS; run `npm run build` first')
}

const CLOCK_PATTERN = '^([01]\\d|2[0-3]):[0-5]\\d$'
const metricNames = [...CANONICAL_METRICS]

/** `$defs` shapes shared by the root document, named after the TypeScript interfaces. */
const DEFS = {
  HysteresisBand: {
    title: 'HysteresisBand',
    description:
      'An enter/exit pair. Hysteresis requires exit < enter, which resolveConfig enforces: a band ' +
      'with exit >= enter is rejected.',
    type: 'object',
    additionalProperties: false,
    required: ['enter', 'exit'],
    properties: {
      enter: {
        type: 'number',
        description: 'Pressure at or above which the level is entered.',
      },
      exit: {
        type: 'number',
        description: 'Pressure at or below which the level is left again; must be strictly below "enter".',
      },
    },
  },

  MetricBand: {
    title: 'MetricBand',
    description:
      "Where one metric's pressure ramp starts and saturates. warn and critical must differ. For a " +
      'lower-is-worse metric (ram_available_bytes, recovery_rate) "warn" is the higher of the two numbers.',
    type: 'object',
    additionalProperties: false,
    required: ['warn', 'critical'],
    properties: {
      warn: {
        type: 'number',
        description: 'Value at which this metric starts contributing pressure.',
      },
      critical: {
        type: 'number',
        description: 'Value at which this metric contributes a full 100.',
      },
    },
  },

  MetricConfig: {
    title: 'MetricConfig',
    description:
      'Per-metric overrides. A metric without a "band" is still collected and its trend term still ' +
      'applies, but it is never scored against a threshold.',
    type: 'object',
    additionalProperties: false,
    properties: {
      band: {
        $ref: '#/$defs/MetricBand',
      },
      weight: {
        type: 'number',
        minimum: 0,
        description: 'Weight of this metric inside its dimension; defaults to 1.',
      },
      sustainMs: {
        type: 'number',
        minimum: 0,
        description: 'Milliseconds the metric must stay in a band before its level counts. Must be >= 0.',
      },
      trendPointsPerHour: {
        type: 'number',
        minimum: 0,
        description: 'Points added per hour of upward trend, capped by trendCap. Must be >= 0.',
      },
      trendCap: {
        type: 'number',
        minimum: 0,
        description: 'Maximum trend contribution for this metric; defaults to 25. Must be >= 0.',
      },
    },
  },

  SamplingConfig: {
    title: 'SamplingConfig',
    description: 'Provider collection cadence, in milliseconds.',
    type: 'object',
    additionalProperties: false,
    properties: {
      intervalMs: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Milliseconds between scheduler ticks. Must be > 0.',
      },
      trendIntervalMs: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Milliseconds between trend evaluations. Must be > 0.',
      },
      persistIntervalMs: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Milliseconds between persistence flushes. Must be > 0.',
      },
      providerBackoffMs: {
        type: 'number',
        minimum: 0,
        description: 'Backoff applied after the first provider failure. Must be >= 0.',
      },
      providerBackoffMaxMs: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Upper bound of the exponential provider backoff. Must be > 0.',
      },
    },
  },

  WindowConfig: {
    title: 'WindowConfig',
    description: 'Rolling window definitions, in milliseconds.',
    type: 'object',
    additionalProperties: false,
    properties: {
      rawMs: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Minimum retention horizon for raw samples. Must be > 0. The effective retention is ' +
          'max(rawMs, longest statistics window), so a longer window is always fully backed by samples.',
      },
      windowsMs: {
        type: 'array',
        minItems: 1,
        'x-strictly-ascending': true,
        description:
          'Windows kept for statistics. Must be a non-empty array of strictly ascending positive ' +
          'numbers: resolveConfig rejects an empty array, a non-positive entry, or a repeat/lower value.',
        items: {
          type: 'number',
          exclusiveMinimum: 0,
        },
      },
      aggregateBucketMs: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Aggregated bucket size for long-horizon history. Must be > 0.',
      },
      aggregateRetentionMs: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'How long aggregates are retained; defaults to 24 h. Must be > 0.',
      },
      dailyRetentionMs: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'How long daily summaries are retained; defaults to 14 days. Must be > 0.',
      },
    },
  },

  TrendConfig: {
    title: 'TrendConfig',
    description: 'Memory- and trend-specific tuning.',
    type: 'object',
    additionalProperties: false,
    properties: {
      minSamples: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Minimum samples before a slope is reported at all. Must be > 0; the resolver truncates ' +
          'fractions and raises anything below 2 to 2.',
      },
      minSpanMs: {
        type: 'number',
        minimum: 0,
        description: 'Minimum span before a slope is reported. Must be >= 0.',
      },
      minRSquared: {
        type: 'number',
        description: 'Minimum R^2 for a slope to be trusted as a trend. Must be a finite number.',
      },
    },
  },

  PressureWeights: {
    title: 'PressureWeights',
    description:
      'The six dimension weights of the restart-pressure model. Every value must be a finite number ' +
      '>= 0 and the six values together must have a positive total, which resolveConfig enforces.',
    type: 'object',
    additionalProperties: false,
    properties: {
      time: { type: 'number', minimum: 0 },
      thermal: { type: 'number', minimum: 0 },
      memory: { type: 'number', minimum: 0 },
      runtime: { type: 'number', minimum: 0 },
      worker: { type: 'number', minimum: 0 },
      computer_use_ui: { type: 'number', minimum: 0 },
    },
  },

  ActionThresholds: {
    title: 'ActionThresholds',
    description:
      'Action ladder thresholds with hysteresis. Two ladder rules are enforced by resolveConfig: each ' +
      '"enter" must be strictly above the previous rung\'s "enter", and each "exit" must not fall below ' +
      'the previous rung\'s "exit".',
    type: 'object',
    additionalProperties: false,
    'x-enter-strictly-increasing': true,
    properties: {
      throttle: { $ref: '#/$defs/HysteresisBand' },
      pause_new_work: { $ref: '#/$defs/HysteresisBand' },
      request_app_restart: { $ref: '#/$defs/HysteresisBand' },
      request_system_reboot: { $ref: '#/$defs/HysteresisBand' },
    },
  },

  CooldownConfig: {
    title: 'CooldownConfig',
    description: 'Self-imposed cooldowns, in milliseconds. Each value must be >= 0.',
    type: 'object',
    additionalProperties: false,
    properties: {
      throttleMs: { type: 'number', minimum: 0 },
      maintenanceMs: { type: 'number', minimum: 0 },
      escalationMs: { type: 'number', minimum: 0 },
    },
  },

  ThrottleConfig: {
    title: 'ThrottleConfig',
    description: 'What the THROTTLE action actually asks for.',
    type: 'object',
    additionalProperties: false,
    properties: {
      concurrencyLimit: {
        type: ['number', 'null'],
        exclusiveMinimum: 0,
        description:
          'Worker concurrency the THROTTLE action asks the harness to adopt. null leaves the harness ' +
          'limit in place and only pauses new admission. A number must be > 0; the resolver truncates ' +
          'fractions and raises anything below 1 to 1.',
      },
      concurrencyFactor: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Fraction by which the observed active worker count is reduced when concurrencyLimit is null. ' +
          'Must be > 0; the resolver clamps it into the 0.05..1 range.',
      },
    },
  },

  MaintenanceConfig: {
    title: 'MaintenanceConfig',
    description: 'Maintenance window configuration.',
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Whether scheduled maintenance is armed at all.',
      },
      targetTime: {
        type: 'string',
        pattern: CLOCK_PATTERN,
        description: 'Local wall-clock target, "HH:MM", 24-hour.',
      },
      windowStart: {
        type: 'string',
        pattern: CLOCK_PATTERN,
        description: 'Local wall-clock start of the allowed window, "HH:MM", 24-hour.',
      },
      windowEnd: {
        type: 'string',
        pattern: CLOCK_PATTERN,
        description: 'Local wall-clock end of the allowed window, "HH:MM", 24-hour.',
      },
      maxDeferMs: {
        type: 'number',
        minimum: 0,
        description: 'Maximum deferral past the target, in milliseconds. Must be >= 0.',
      },
      urgentOverridePressure: {
        type: ['number', 'null'],
        description:
          'Pressure at or above which the window is ignored and maintenance becomes urgent. null ' +
          'disables the override; a number must be finite.',
      },
      allowAppRestart: {
        type: 'boolean',
        description: 'Whether a maintenance restart request may be raised at all.',
      },
      safePointRequired: {
        type: 'boolean',
        description: 'Whether a reported safe point is required before a restart request is raised.',
      },
    },
  },

  AntiFlapConfig: {
    title: 'AntiFlapConfig',
    description: 'Anti-flapping and re-request configuration.',
    type: 'object',
    additionalProperties: false,
    properties: {
      minStateDwellMs: {
        type: 'number',
        minimum: 0,
        description: 'Minimum time in a state before another transition is allowed. Must be >= 0.',
      },
      minRepeatActionMs: {
        type: 'number',
        minimum: 0,
        description: 'Minimum time between two identical applied actions. Must be >= 0.',
      },
      debounceEvaluations: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Consecutive evaluations a condition must hold before it is actionable; 1 disables debounce. ' +
          'Must be > 0; the resolver truncates fractions and raises anything below 1 to 1.',
      },
    },
  },

  ResilienceConfig: {
    title: 'ResilienceConfig',
    description: 'Failure isolation and adapter tuning.',
    type: 'object',
    additionalProperties: false,
    properties: {
      providerFailureLimit: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Consecutive provider failures before the provider is disabled temporarily. Must be > 0; the ' +
          'resolver truncates fractions and raises anything below 1 to 1.',
      },
      providerRetryAfterBackoff: {
        type: 'boolean',
        description: 'Whether a failing provider is retried after a backoff.',
      },
    },
  },

  StorageConfig: {
    title: 'StorageConfig',
    description: 'Persistence bounds.',
    type: 'object',
    additionalProperties: false,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Whether anything is written to disk.',
      },
      directory: {
        type: ['string', 'null'],
        description: 'Directory override; null means <DSH_HOME>/health-scheduler.',
      },
      maxLogBytes: {
        type: 'number',
        exclusiveMinimum: 0,
        description: 'Maximum bytes of the rolling JSONL decision log. Must be > 0.',
      },
      maxRecentDecisions: {
        type: 'number',
        exclusiveMinimum: 0,
        description:
          'Maximum decision records kept in memory for the UI. Must be > 0; the resolver truncates ' +
          'fractions and raises anything below 1 to 1.',
      },
    },
  },

  ProviderOptions: {
    title: 'ProviderOptions',
    description: 'Per-provider options for the built-in providers.',
    type: 'object',
    additionalProperties: false,
    properties: {
      hardware: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ignoreMetrics: {
            type: 'array',
            description: 'Metric names treated as unavailable even when a sensor exists.',
            items: { type: 'string', enum: metricNames },
          },
          helperCommand: {
            type: ['array', 'null'],
            description:
              'Thermal-zone paths to read on Linux, or a Windows helper executable that prints ' +
              '"name,value" lines on stdout. null disables the helper.',
            items: { type: 'string' },
          },
          helperTimeoutMs: {
            type: 'number',
            exclusiveMinimum: 0,
            description: 'Milliseconds a helper command may run before it is abandoned. Must be > 0.',
          },
        },
      },
      memory: {
        type: 'object',
        additionalProperties: false,
        properties: {
          extraPids: {
            type: 'array',
            description: 'Process ids to include in the process-tree memory sums.',
            items: { type: 'number', minimum: 0 },
          },
        },
      },
      runtime: {
        type: 'object',
        additionalProperties: false,
        properties: {
          heartbeatFile: {
            type: ['string', 'null'],
            description:
              'Heartbeat file the host writes on every event-loop turn; null disables the ' +
              'heartbeat_delay_ms reading.',
          },
          heartbeatExpectedMs: {
            type: 'number',
            exclusiveMinimum: 0,
            description: 'Expected heartbeat cadence, in milliseconds. Must be > 0.',
          },
        },
      },
      statsFile: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: {
            type: 'array',
            description:
              'Paths the host or an integration writes canonical metrics into, newest write wins. Each ' +
              'entry must be a non-empty string.',
            items: { type: 'string', minLength: 1 },
          },
          staleAfterMs: {
            type: 'number',
            exclusiveMinimum: 0,
            description: "Milliseconds after which a file's contents are treated as stale. Must be > 0.",
          },
          commands: {
            type: 'array',
            description: 'Extra command probes: "name,value" lines on stdout mapped to canonical metrics.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['argv'],
              properties: {
                argv: {
                  type: 'array',
                  minItems: 1,
                  description: 'Command and arguments, executed without a shell. Must be non-empty.',
                  items: { type: 'string' },
                },
                timeoutMs: {
                  type: 'number',
                  exclusiveMinimum: 0,
                  description: 'Milliseconds the command may run before it is abandoned. Defaults to 5000.',
                },
                format: {
                  const: 'name-value',
                  description: 'Output format; only "name-value" is supported and it is forced by the resolver.',
                },
              },
            },
          },
        },
      },
    },
  },
}

/** JSON Schema (draft 2020-12) for a `dsh-health-scheduler` configuration document. */
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'dsh-health-scheduler configuration',
  description:
    'A plugin configuration document. It is a partial override: it is deep-merged onto the selected ' +
    'preset, and every leaf it omits is taken from that preset (balanced when "preset" is absent). ' +
    'Objects and bands are closed here (additionalProperties: false) because unknown keys and ' +
    'half-specified bands are almost always typos; the runtime validator rejects them too. The ' +
    'constraints stated per field are the ones resolveConfig in src/core/config.ts enforces.',
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: {
      type: 'boolean',
      description: 'Master switch. When false the plugin loads but collects nothing. Defaults to true.',
    },
    preset: {
      type: 'string',
      enum: ['conservative', 'balanced', 'aggressive', 'custom'],
      description:
        'Selects the shipped preset the document is based on. Explicit values always win over the ' +
        'preset. An unrecognised name falls back to balanced at runtime, so it is not accepted here.',
    },
    sampling: { $ref: '#/$defs/SamplingConfig' },
    windows: { $ref: '#/$defs/WindowConfig' },
    trend: { $ref: '#/$defs/TrendConfig' },
    weights: { $ref: '#/$defs/PressureWeights' },
    thresholds: { $ref: '#/$defs/ActionThresholds' },
    metrics: {
      type: 'object',
      description:
        'Per-metric scoring overrides keyed by canonical metric name. Keys must come from the ' +
        'canonical registry; resolveConfig rejects any other name and lists the known ones.',
      propertyNames: { enum: metricNames },
      additionalProperties: { $ref: '#/$defs/MetricConfig' },
    },
    cooldowns: { $ref: '#/$defs/CooldownConfig' },
    throttle: { $ref: '#/$defs/ThrottleConfig' },
    maintenance: { $ref: '#/$defs/MaintenanceConfig' },
    antiFlap: { $ref: '#/$defs/AntiFlapConfig' },
    resilience: { $ref: '#/$defs/ResilienceConfig' },
    storage: { $ref: '#/$defs/StorageConfig' },
    disabledProviders: {
      type: 'array',
      description:
        'Provider ids to disable, e.g. ["hardware"] on a machine with no sensors. Every entry must be ' +
        'a non-empty string; entries are trimmed by the resolver.',
      items: { type: 'string', minLength: 1 },
    },
    providerOptions: { $ref: '#/$defs/ProviderOptions' },
  },
  $defs: DEFS,
}

/** The generated documents, by path relative to the project root. */
const DOCUMENTS = [
  ...PRESET_NAMES.map((name) => ({
    relative: `presets/${name}.json`,
    label: `PRESETS.${name}`,
    value: PRESETS[name],
  })),
  { relative: 'presets/schema.json', label: 'the configuration schema', value: schema },
]

let stale = 0

if (!checkOnly) await mkdir(presetsDir, { recursive: true })

for (const document of DOCUMENTS) {
  if (document.value === null || typeof document.value !== 'object') {
    throw new Error(`${document.label} is not an object; run \`npm run build\` first`)
  }

  // A trailing newline keeps the files POSIX-clean and diff-friendly.
  const serialized = `${JSON.stringify(document.value, null, 2)}\n`
  const target = path.join(projectRoot, ...document.relative.split('/'))

  if (checkOnly) {
    const current = await readFile(target, 'utf8').catch(() => null)
    if (current === serialized) {
      console.log(`ok   ${document.relative} matches ${document.label}`)
    } else {
      console.log(`FAIL ${document.relative} is stale; run "npm run presets"`)
      stale += 1
    }
    continue
  }

  await writeFile(target, serialized, 'utf8')
  console.log(`wrote ${document.relative}`)
}

if (checkOnly) {
  if (stale > 0) process.exitCode = 1
  else console.log(`ok   ${DOCUMENTS.length} generated files are up to date`)
}
