/**
 * Shared provider plumbing: stats-file ingestion and external command probes.
 *
 * The design forbids the scheduler from reaching into NVML, LibreHardwareMonitor,
 * HWiNFO, Windows APIs, worker internals or Electron internals. Those live
 * *outside* the process, so this module is the one sanctioned way to hear from
 * them: an integration writes canonical metrics to a JSON file, or an external
 * tool prints `name=value` lines, and a provider reports what it finds.
 *
 * @module dsh-health-scheduler/providers/sources
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isCanonicalMetric, type CanonicalMetric, type MetricBag } from '../types/metrics.js'
import type { CommandProbeConfig } from '../types/config.js'
import type { DegradedReason } from '../types/provider.js'

/** What a stats file looked like when it was read. */
export interface StatsFileSnapshot {
  /** Canonical metrics found in the file. */
  readonly metrics: MetricBag
  /** Metric keys present in the file that are not canonical. */
  readonly unknownKeys: readonly string[]
  /** File modification time, epoch milliseconds, or `null` when unreadable. */
  readonly mtimeMs: number | null
  /** Whether the file exists and parsed. */
  readonly readable: boolean
  /** Whether the newest write is older than the configured staleness bound. */
  readonly stale: boolean
  /** Why the read failed or degraded. */
  readonly reason: DegradedReason | null
  /** Free-form detail for the audit log. */
  readonly detail: string | null
}

/**
 * Reads the first readable stats file from a list.
 *
 * The file format is deliberately dull:
 *
 * ```json
 * { "timestamp": "2026-01-01T00:00:00.000Z", "metrics": { "render_latency_ms": 120 } }
 * ```
 *
 * A bare `{ "render_latency_ms": 120 }` object is accepted too, because writing
 * the wrapper is easy to forget. Non-canonical keys are reported rather than
 * folded in, so a typo shows up as an unknown key instead of silently doing
 * nothing.
 */
export class StatsFileSource {
  private readonly paths: readonly string[]
  private readonly staleAfterMs: number
  private cache: StatsFileSnapshot = emptySnapshot()
  private cachedAt = 0
  private readonly cacheMs: number

  constructor(paths: readonly string[], staleAfterMs: number, cacheMs = 2_000) {
    this.paths = paths
    this.staleAfterMs = staleAfterMs
    this.cacheMs = cacheMs
  }

  /** Whether any path is configured. */
  get configured(): boolean {
    return this.paths.length > 0
  }

  /**
   * Read the newest readable file, at most once per cache window.
   *
   * @param nowMs - evaluation instant.
   */
  read(nowMs: number): StatsFileSnapshot {
    if (!this.configured) return emptySnapshot()
    if (nowMs - this.cachedAt < this.cacheMs) return this.cache
    this.cachedAt = nowMs
    this.cache = this.readUncached(nowMs)
    return this.cache
  }

  private readUncached(nowMs: number): StatsFileSnapshot {
    let sawExisting = false
    let lastReason: DegradedReason | null = null
    let lastDetail: string | null = null

    for (const path of this.paths) {
      if (!existsSync(path)) continue
      sawExisting = true
      try {
        const stat = statSync(path)
        const raw = readFileSync(path, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        const { metrics, unknownKeys } = extractMetrics(parsed)
        const stale = nowMs - stat.mtimeMs > this.staleAfterMs
        return {
          metrics,
          unknownKeys,
          mtimeMs: stat.mtimeMs,
          readable: true,
          stale,
          reason: stale ? 'telemetry_unavailable' : null,
          detail: stale
            ? `stats file ${path} last written ${Math.round((nowMs - stat.mtimeMs) / 1000)}s ago`
            : null,
        }
      } catch (error) {
        lastReason = 'telemetry_unavailable'
        lastDetail = `${path}: ${(error as Error).message}`
      }
    }

    if (!sawExisting) {
      return {
        ...emptySnapshot(),
        reason: 'telemetry_unavailable',
        detail: `no stats file exists yet (looked for ${this.paths.join(', ')})`,
      }
    }
    return { ...emptySnapshot(), reason: lastReason, detail: lastDetail }
  }
}

function emptySnapshot(): StatsFileSnapshot {
  return {
    metrics: {},
    unknownKeys: [],
    mtimeMs: null,
    readable: false,
    stale: false,
    reason: null,
    detail: null,
  }
}

/** Pull canonical metrics out of a parsed stats document. */
export function extractMetrics(parsed: unknown): { metrics: MetricBag; unknownKeys: string[] } {
  const metrics: MetricBag = {}
  const unknownKeys: string[] = []
  if (typeof parsed !== 'object' || parsed === null) return { metrics, unknownKeys }
  const record = parsed as Record<string, unknown>
  const container =
    typeof record.metrics === 'object' && record.metrics !== null
      ? (record.metrics as Record<string, unknown>)
      : record
  for (const [key, value] of Object.entries(container)) {
    if (key === 'timestamp' || key === 'schemaVersion' || key === 'source') continue
    if (!isCanonicalMetric(key)) {
      unknownKeys.push(key)
      continue
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      ;(metrics as Record<string, number>)[key] = value
    }
  }
  return { metrics, unknownKeys: unknownKeys.sort() }
}

/** Result of one external command probe. */
export interface CommandProbeResult {
  /** Canonical metrics parsed from stdout. */
  readonly metrics: MetricBag
  /** Canonical metric names the command mentioned but with unparsable values. */
  readonly malformed: readonly string[]
  /** Error message when the command failed, timed out, or was unavailable. */
  readonly error: string | null
}

/** Parse `name=value` / `name,value` lines from a command's stdout. */
export function parseNameValueLines(stdout: string): { metrics: MetricBag; malformed: string[] } {
  const metrics: MetricBag = {}
  const malformed: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = /^([A-Za-z][A-Za-z0-9_]*)\s*[=,]\s*(.+)$/.exec(trimmed)
    if (match === null) continue
    const name = match[1] as string
    if (!isCanonicalMetric(name)) continue
    const value = Number((match[2] as string).trim())
    if (!Number.isFinite(value)) {
      malformed.push(name)
      continue
    }
    ;(metrics as Record<string, number>)[name] = value
  }
  return { metrics, malformed }
}

/**
 * Run one configured command probe.
 *
 * `execFile` is used without a shell, so a configured command cannot be turned
 * into shell injection by a crafted metric value. Timeouts kill the child and
 * surface as an error the caller reports as a degraded sample.
 */
export function runCommandProbe(config: CommandProbeConfig): Promise<CommandProbeResult> {
  const [file, ...args] = config.argv
  if (file === undefined) {
    return Promise.resolve({ metrics: {}, malformed: [], error: 'command probe has an empty argv' })
  }
  return new Promise<CommandProbeResult>((resolve) => {
    execFile(
      file,
      args,
      { timeout: config.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          const message =
            (error as NodeJS.ErrnoException & { killed?: boolean }).killed === true
              ? `command probe timed out after ${config.timeoutMs} ms`
              : (error.message || String(error))
          resolve({ metrics: {}, malformed: [], error: message })
          return
        }
        const parsed = parseNameValueLines(stdout)
        resolve({ metrics: parsed.metrics, malformed: parsed.malformed, error: null })
      },
    )
  })
}

/** Merge metric bags left to right; later bags win. */
export function mergeBags(...bags: readonly MetricBag[]): MetricBag {
  const out: MetricBag = {}
  for (const bag of bags) {
    for (const [metric, value] of Object.entries(bag) as Array<[CanonicalMetric, number]>) {
      ;(out as Record<string, number>)[metric] = value
    }
  }
  return out
}
