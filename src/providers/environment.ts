/**
 * Runtime environment shared by the built-in providers.
 *
 * Everything a provider needs from the outside world arrives through this
 * object. That is what makes the providers testable without a real machine: a
 * test supplies its own clock, its own `os` shape and its own probe runner, and
 * the provider cannot tell the difference.
 *
 * @module dsh-health-scheduler/providers/environment
 */

import * as nodeOs from 'node:os'
import * as nodeProcess from 'node:process'
import type { CommandProbeConfig } from '../types/config.js'
import { runCommandProbe, type CommandProbeResult } from './sources.js'

/** The subset of `node:os` the providers use. */
export interface OsFacade {
  cpus(): readonly {
    model: string
    speed: number
    times: { user: number; nice: number; sys: number; idle: number; irq: number }
  }[]
  totalmem(): number
  freemem(): number
  loadavg(): readonly number[]
  uptime(): number
  platform(): string
  arch(): string
  hostname(): string
  release(): string
}

/** Read-only facts about the running process. */
export interface ProcessFacade {
  readonly pid: number
  readonly uptimeSeconds: number
  readonly rssBytes: number
  readonly heapUsedBytes: number
  readonly externalBytes: number
  /** Number of active libuv resources, when the runtime can report them. */
  readonly activeHandles: number | null
  readonly activeRequests: number | null
  /** Sum of resident bytes for the process tree, when a platform helper answered. */
  readonly treeRssBytes: number | null
}

/** Provider-injected environment. */
export interface ProviderEnvironment {
  /** Wall clock in epoch milliseconds. */
  readonly clock: () => number
  /** `node:os` facade. */
  readonly os: OsFacade
  /**
   * Running-process facade.
   *
   * A getter, not a snapshot: uptime, RSS and handle counts change between ticks, and
   * a provider that reads a value captured at construction would report the uptime the
   * process had when the plugin loaded, forever. The `runtime` provider's whole time
   * dimension depends on this being current.
   */
  readonly process: ProcessFacade
  /** Directory the plugin may write scratch state into, or `null`. */
  readonly stateDirectory: string | null
  /** Run one external command probe. */
  readonly runProbe: (config: CommandProbeConfig) => Promise<CommandProbeResult>
}

/** Active libuv resource counts, when the runtime exposes them. */
function activeResources(): { handles: number | null; requests: number | null } {
  const getInfo = (nodeProcess as unknown as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo
  if (typeof getInfo !== 'function') return { handles: null, requests: null }
  try {
    const info = getInfo()
    const requests = info.filter((entry) => !entry.endsWith('Wrap') && entry !== 'Timeout').length
    const handles = info.filter((entry) => entry.endsWith('Wrap') || entry === 'Timeout').length
    return { handles, requests }
  } catch {
    return { handles: null, requests: null }
  }
}

/** Build the real environment from Node's own modules. */
export function defaultEnvironment(options: { stateDirectory?: string | null } = {}): ProviderEnvironment {
  const fixed: Omit<ProcessFacade, 'uptimeSeconds' | 'rssBytes' | 'heapUsedBytes' | 'externalBytes' | 'activeHandles' | 'activeRequests'> = {
    pid: nodeProcess.pid,
    treeRssBytes: null,
  }
  return {
    clock: () => Date.now(),
    os: {
      cpus: () => nodeOs.cpus(),
      totalmem: () => nodeOs.totalmem(),
      freemem: () => nodeOs.freemem(),
      loadavg: () => nodeOs.loadavg(),
      uptime: () => nodeOs.uptime(),
      platform: () => nodeOs.platform(),
      arch: () => nodeOs.arch(),
      hostname: () => nodeOs.hostname(),
      release: () => nodeOs.release(),
    },
    // Read through on every access. `uptime_seconds` in particular is the input to the
    // whole `time` dimension, and a value captured once at construction would freeze it.
    get process(): ProcessFacade {
      return readProcessFacade(fixed)
    },
    stateDirectory: options.stateDirectory ?? null,
    runProbe: (config) => runCommandProbe(config),
  }
}

/** Read the volatile process numbers now. */
export function readProcessFacade(base: Partial<ProcessFacade> = {}): ProcessFacade {
  const memory = nodeProcess.memoryUsage()
  const { handles, requests } = activeResources()
  return {
    pid: base.pid ?? nodeProcess.pid,
    treeRssBytes: base.treeRssBytes ?? null,
    uptimeSeconds: nodeProcess.uptime(),
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    activeHandles: handles,
    activeRequests: requests,
  }
}
