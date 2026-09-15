/**
 * Hardware provider: CPU/GPU temperature, utilisation, throttle and power-limit
 * telemetry.
 *
 * What is measured natively:
 *
 * - `cpu_usage` — the delta of `os.cpus()` time counters between two samples.
 *   This is a real aggregate utilisation number and needs no privileges.
 *
 * What is *not* available natively, and is therefore reported as absent rather
 * than as zero:
 *
 * - `cpu_temp_c`, `gpu_temp_c`, `gpu_usage`, `thermal_throttle`, `power_limit_hit`
 *
 * Those arrive through one of two sanctioned seams: a `helperCommand` that prints
 * `metric=value` lines (for example a PowerShell one-liner reading
 * LibreHardwareMonitor's WMI namespace, or `nvidia-smi --query-gpu`), or an
 * external integration writing the metrics into a stats file. When neither is
 * configured the provider reports a degraded, empty sample — which the pressure
 * model scores as `unknown`, never as healthy.
 *
 * @module dsh-health-scheduler/providers/hardware
 */

import type { CommandProbeConfig, ProviderOptions } from '../types/config.js'
import type { HealthProvider, HealthSample } from '../types/provider.js'
import type { CanonicalMetric } from '../types/metrics.js'
import type { ProviderEnvironment } from './environment.js'
import { mergeBags } from './sources.js'

const PROVIDES: readonly CanonicalMetric[] = [
  'cpu_temp_c',
  'cpu_usage',
  'gpu_temp_c',
  'gpu_usage',
  'power_limit_hit',
  'thermal_throttle',
]

interface CpuTimes {
  idle: number
  total: number
}

/**
 * Reads what the OS exposes and merges in whatever an external helper adds.
 */
export class HardwareProvider implements HealthProvider {
  readonly id = 'hardware'
  readonly group = 'hardware' as const
  readonly provides = PROVIDES
  readonly enabled = true

  private readonly environment: ProviderEnvironment
  private readonly options: ProviderOptions['hardware']
  private previous: CpuTimes | null = null

  constructor(environment: ProviderEnvironment, options: ProviderOptions['hardware']) {
    this.environment = environment
    this.options = options
  }

  async sample(): Promise<HealthSample> {
    const nowMs = this.environment.clock()
    const timestamp = new Date(nowMs).toISOString()
    const metrics: Record<string, number> = {}

    const cpuUsage = this.cpuUsage()
    if (cpuUsage !== null && !this.ignored('cpu_usage')) {
      metrics.cpu_usage = cpuUsage
    }

    let degraded = false
    let reason: HealthSample['degradedReason']
    const notes: string[] = []

    if (this.options.helperCommand !== null) {
      const config: CommandProbeConfig = {
        argv: this.options.helperCommand,
        timeoutMs: this.options.helperTimeoutMs,
        format: 'name-value',
      }
      const result = await this.environment.runProbe(config)
      if (result.error !== null) {
        degraded = true
        reason = 'telemetry_unavailable'
        notes.push(`helperCommand failed: ${result.error}`)
      } else {
        const filtered = this.filterIgnored(result.metrics)
        Object.assign(metrics, filtered)
        if (result.malformed.length > 0) {
          degraded = true
          reason = 'telemetry_unavailable'
          notes.push(`unparsable values for ${result.malformed.join(', ')}`)
        }
        if (Object.keys(result.metrics).length === 0) {
          degraded = true
          reason = 'telemetry_unavailable'
          notes.push('helperCommand printed no canonical metric lines')
        }
      }
    } else {
      degraded = true
      reason = 'telemetry_unavailable'
      notes.push(
        'no thermal telemetry source configured: set providerOptions.hardware.helperCommand or write a stats file',
      )
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

  /** Aggregate CPU utilisation from the delta of `os.cpus()` counters. */
  private cpuUsage(): number | null {
    let idle = 0
    let total = 0
    for (const cpu of this.environment.os.cpus()) {
      const times = cpu.times
      idle += times.idle
      total += times.user + times.nice + times.sys + times.idle + times.irq
    }
    const current: CpuTimes = { idle, total }
    const previous = this.previous
    this.previous = current
    if (previous === null) return null
    const totalDelta = current.total - previous.total
    const idleDelta = current.idle - previous.idle
    if (totalDelta <= 0 || idleDelta < 0) return null
    const usage = 1 - idleDelta / totalDelta
    return Math.min(1, Math.max(0, usage))
  }

  private ignored(metric: CanonicalMetric): boolean {
    return this.options.ignoreMetrics.includes(metric)
  }

  private filterIgnored(bag: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [metric, value] of Object.entries(bag)) {
      if (this.ignored(metric as CanonicalMetric)) continue
      out[metric] = value
    }
    return out
  }
}

/** Exposed for tests and for the acceptance harness. */
export function mergeHardwareMetrics(
  native: Record<string, number>,
  external: Record<string, number>,
): Record<string, number> {
  return mergeBags(native, external) as Record<string, number>
}
