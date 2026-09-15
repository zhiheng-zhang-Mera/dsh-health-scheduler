/**
 * Memory provider: RAM, commit charge, process RSS/private bytes and VRAM.
 *
 * `ram_total_bytes`, `ram_available_bytes`, `ram_used_ratio` and
 * `process_rss_bytes` come straight from Node. Commit charge, private bytes and
 * VRAM need a platform seam: on Windows a `helperCommand` reading
 * `Win32_OperatingSystem` / `Win32_PerfRawData_PerfProc_Process` can supply them,
 * and an external integration can always write them into a stats file.
 *
 * The interesting output of this provider is not any single number — it is the
 * pair `(level, slope)`. A machine at 70 % RAM with a flat slope is fine; a
 * machine at 55 % RAM climbing 400 MB/h is leaking, and the pressure model reads
 * the slope through the trend analyzer.
 *
 * @module dsh-health-scheduler/providers/memory
 */

import type { CommandProbeConfig, ProviderOptions } from '../types/config.js'
import type { CanonicalMetric } from '../types/metrics.js'
import type { HealthProvider, HealthSample } from '../types/provider.js'
import type { ProviderEnvironment } from './environment.js'

const PROVIDES: readonly CanonicalMetric[] = [
  'commit_used_ratio',
  'process_private_bytes',
  'process_rss_bytes',
  'ram_available_bytes',
  'ram_total_bytes',
  'ram_used_ratio',
  'vram_used_ratio',
]

/** Optional platform seam for the memory numbers Node cannot see. */
export interface MemoryHelper {
  /** Configured helper command, or `null`. */
  readonly command: readonly string[] | null
  /** Command budget in milliseconds. */
  readonly timeoutMs: number
}

/** Reads memory telemetry that Node exposes plus whatever a helper adds. */
export class MemoryProvider implements HealthProvider {
  readonly id = 'memory'
  readonly group = 'memory' as const
  readonly provides = PROVIDES
  readonly enabled = true

  private readonly environment: ProviderEnvironment
  private readonly options: ProviderOptions['memory']
  private readonly helper: MemoryHelper

  constructor(environment: ProviderEnvironment, options: ProviderOptions['memory'], helper: MemoryHelper) {
    this.environment = environment
    this.options = options
    this.helper = helper
  }

  async sample(): Promise<HealthSample> {
    const nowMs = this.environment.clock()
    const timestamp = new Date(nowMs).toISOString()
    const metrics: Record<string, number> = {}
    const notes: string[] = []

    const total = this.environment.os.totalmem()
    const available = this.environment.os.freemem()
    if (total > 0) {
      metrics.ram_total_bytes = total
      metrics.ram_available_bytes = available
      metrics.ram_used_ratio = Math.min(1, Math.max(0, 1 - available / total))
    } else {
      notes.push('os.totalmem() reported 0, RAM metrics omitted')
    }

    const rss = this.environment.process.treeRssBytes ?? this.environment.process.rssBytes
    if (rss > 0) metrics.process_rss_bytes = rss

    let degraded = total <= 0
    let reason: HealthSample['degradedReason'] = total <= 0 ? 'telemetry_unavailable' : undefined

    if (this.helper.command !== null) {
      const config: CommandProbeConfig = {
        argv: this.helper.command,
        timeoutMs: this.helper.timeoutMs,
        format: 'name-value',
      }
      const result = await this.environment.runProbe(config)
      if (result.error !== null) {
        degraded = true
        reason = 'telemetry_unavailable'
        notes.push(`helperCommand failed: ${result.error}`)
      } else {
        for (const [metric, value] of Object.entries(result.metrics)) {
          metrics[metric] = value as number
        }
        if (result.malformed.length > 0) {
          degraded = true
          reason = 'telemetry_unavailable'
          notes.push(`unparsable values for ${result.malformed.join(', ')}`)
        }
      }
    } else {
      notes.push(
        'commit charge, private bytes and VRAM are absent: set providerOptions.memory.helperCommand or write a stats file',
      )
    }

    if (this.options.extraPids.length > 0) {
      notes.push(`process tree RSS includes ${this.options.extraPids.length} configured extra pid(s)`)
    }

    if (metrics.commit_used_ratio === undefined && metrics.vram_used_ratio === undefined) {
      degraded = true
      reason ??= 'telemetry_unavailable'
    }

    return {
      provider: this.id,
      timestamp,
      metrics,
      ...(degraded ? { degraded: true } : {}),
      ...(reason === undefined ? {} : { degradedReason: reason }),
      ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    }
  }
}
