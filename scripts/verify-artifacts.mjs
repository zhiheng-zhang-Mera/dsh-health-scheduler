#!/usr/bin/env node
/**
 * Artifact check for the built package.
 *
 * Asserts that `lib/` is a usable, clean build before it is published or loaded by
 * the harness: the entry point exposes the plugin surface, no emitted file still
 * refers to a `.ts` specifier, the declaration entry point exists, the metric
 * vocabulary resolves, the three presets resolve with the expected ordering, and
 * genuinely invalid documents are rejected.
 *
 * Zero dependencies, no test framework: one `ok`/`FAIL` line per check, and a
 * non-zero exit code when anything failed.
 *
 * Usage:
 *   npm run build && npm run verify:artifacts
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const libDir = path.join(projectRoot, 'lib')
const libEntry = path.join(libDir, 'index.js')
const typeEntry = path.join(libDir, 'types', 'index.d.ts')

/** A `from './x.ts'` / `import('../x.ts')` specifier in an emitted file. */
const TS_SPECIFIER = /(?:\bfrom\b|\bimport\b)\s*\(?\s*(['"])(\.{1,2}\/[^'"]+\.ts)\1/g

let passed = 0
let failed = 0

/** Print one result line, plus an indented reason when a check failed. */
function report(ok, description, detail) {
  if (ok) {
    passed += 1
    console.log(`ok   ${description}`)
  } else {
    failed += 1
    console.log(`FAIL ${description}`)
    if (detail !== undefined && detail !== '') console.log(`     ${detail}`)
  }
}

/** Run one check; a thrown assertion (or any error) fails it. */
async function check(description, run) {
  try {
    const detail = await run()
    report(true, description, detail)
  } catch (error) {
    report(false, description, error instanceof Error ? error.message : String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Yield every regular file under `directory`, recursively. */
async function* walkFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* walkFiles(full)
    else if (entry.isFile()) yield full
  }
}

/** `lib/index.js`, imported once and reused by the checks that need it. */
let plugin = null

// 1. The entry point exists and exposes the plugin surface.
await check('lib/index.js exports apply, name, inject, resolveConfig, PRESETS and HealthScheduler', async () => {
  const info = await stat(libEntry)
  assert(info.isFile(), 'lib/index.js is not a regular file')

  plugin = await import(pathToFileURL(libEntry).href)

  assert(typeof plugin.apply === 'function', `apply must be a function, received ${typeof plugin.apply}`)
  assert(
    plugin.name === 'dsh-health-scheduler',
    `name must be "dsh-health-scheduler", received ${JSON.stringify(plugin.name)}`,
  )
  assert(Array.isArray(plugin.inject), `inject must be an array, received ${typeof plugin.inject}`)
  assert(
    plugin.inject.includes('tools'),
    `inject must contain "tools", received ${JSON.stringify(plugin.inject)}`,
  )
  assert(
    typeof plugin.resolveConfig === 'function',
    `resolveConfig must be a function, received ${typeof plugin.resolveConfig}`,
  )
  assert(
    plugin.PRESETS !== null && typeof plugin.PRESETS === 'object',
    `PRESETS must be an object, received ${typeof plugin.PRESETS}`,
  )
  for (const presetName of ['conservative', 'balanced', 'aggressive']) {
    const preset = plugin.PRESETS[presetName]
    assert(
      preset !== null && typeof preset === 'object',
      `PRESETS.${presetName} is missing (received ${typeof preset})`,
    )
  }
  assert(
    typeof plugin.HealthScheduler === 'function',
    `HealthScheduler must be a function, received ${typeof plugin.HealthScheduler}`,
  )

  return `name=${plugin.name}, inject=${JSON.stringify(plugin.inject)}`
})

// 2. No emitted file still points at a TypeScript source.
await check('no file under lib/ imports a ".ts" specifier', async () => {
  const offenders = []
  let scanned = 0

  for await (const file of walkFiles(libDir)) {
    let source
    try {
      source = await readFile(file, 'utf8')
    } catch {
      continue // unreadable/binary artifact: nothing to scan
    }
    scanned += 1
    for (const match of source.matchAll(TS_SPECIFIER)) {
      offenders.push(`${path.relative(projectRoot, file).split(path.sep).join('/')} -> ${match[2]}`)
    }
  }

  assert(scanned > 0, 'no files found under lib/; run `npm run build` first')
  assert(
    offenders.length === 0,
    `found ${offenders.length} leftover TypeScript specifier(s): ${offenders.slice(0, 5).join('; ')}`,
  )

  return `${scanned} files scanned`
})

// 3. The declaration entry point shipped in package.json "types" exists.
await check('lib/types/index.d.ts exists', async () => {
  const info = await stat(typeEntry)
  assert(info.isFile(), 'lib/types/index.d.ts is not a regular file')
  return 'present'
})

// 4. The metric vocabulary resolves and a default document resolves.
await check(
  'every CANONICAL_METRICS name resolves through metricDescriptor, and resolveConfig() succeeds',
  async () => {
    assert(plugin !== null, 'lib/index.js could not be imported (see the first check)')
    assert(Array.isArray(plugin.CANONICAL_METRICS), 'CANONICAL_METRICS must be an array')
    assert(plugin.CANONICAL_METRICS.length > 0, 'CANONICAL_METRICS is empty')

    const unresolved = plugin.CANONICAL_METRICS.filter((name) => {
      const descriptor = plugin.metricDescriptor(name)
      return descriptor === undefined || descriptor === null || descriptor.name !== name
    })
    assert(
      unresolved.length === 0,
      `no usable descriptor for: ${unresolved.join(', ')}`,
    )

    const config = plugin.resolveConfig()
    assert(config !== null && typeof config === 'object', 'resolveConfig() did not return an object')
    assert(
      config.preset === 'balanced',
      `resolveConfig() must default to the balanced preset, received ${JSON.stringify(config.preset)}`,
    )

    return `${plugin.CANONICAL_METRICS.length} metrics, default preset=${config.preset}`
  },
)

// 5. All three presets resolve, in the documented order of aggressiveness.
await check('conservative < balanced < aggressive for thresholds.throttle.enter', async () => {
  assert(plugin !== null, 'lib/index.js could not be imported (see the first check)')

  const enter = (presetName) => {
    const config = plugin.resolveConfig({ preset: presetName })
    assert(
      config !== null && typeof config === 'object',
      `resolveConfig({ preset: '${presetName}' }) did not return an object`,
    )
    const value = config.thresholds?.throttle?.enter
    assert(
      typeof value === 'number' && Number.isFinite(value),
      `thresholds.throttle.enter is not a finite number for ${presetName}: ${JSON.stringify(value)}`,
    )
    return value
  }

  const conservative = enter('conservative')
  const balanced = enter('balanced')
  const aggressive = enter('aggressive')
  assert(
    conservative < balanced && balanced < aggressive,
    `expected conservative < balanced < aggressive, received ${conservative}, ${balanced}, ${aggressive}`,
  )

  return `${conservative} < ${balanced} < ${aggressive}`
})

// 6. Invalid documents are rejected rather than silently coerced.
await check(
  'resolveConfig throws on exit >= enter and on a non-canonical metric name',
  async () => {
    assert(plugin !== null, 'lib/index.js could not be imported (see the first check)')

    let bandError = null
    try {
      plugin.resolveConfig({ thresholds: { throttle: { enter: 50, exit: 60 } } })
    } catch (error) {
      bandError = error
    }
    assert(
      bandError !== null,
      'resolveConfig accepted thresholds.throttle { enter: 50, exit: 60 }; hysteresis requires exit < enter',
    )

    let metricError = null
    try {
      plugin.resolveConfig({ metrics: { not_a_metric: {} } })
    } catch (error) {
      metricError = error
    }
    assert(metricError !== null, 'resolveConfig accepted the non-canonical metric name "not_a_metric"')

    return `threw ${bandError.name} and ${metricError.name}`
  },
)

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
