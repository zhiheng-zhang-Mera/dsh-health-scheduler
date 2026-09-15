/**
 * Process-tree memory reading.
 *
 * `process.memoryUsage()` covers this process only. A harness runs a small tree —
 * the launcher, the agent host, worker threads with their own accounting — and the
 * sum is what a leak actually looks like from outside.
 *
 * Windows and Linux are handled by asking the platform's own process list, on a
 * bounded cadence, off the tick's critical path. A machine where the query is slow
 * or unavailable simply reports the single-process number; it never reports zero,
 * and it never blocks the sampling loop waiting for a subprocess.
 *
 * @module dsh-health-scheduler/providers/process-tree
 */

import { execFile } from 'node:child_process'

/** One process's memory as the platform reported it. */
export interface ProcessMemory {
  readonly pid: number
  readonly rssBytes: number
}

/** A reader for process-tree memory, with its own refresh cadence. */
export class ProcessTreeReader {
  private readonly extraPids: readonly number[]
  private readonly refreshMs: number
  private readonly runner: (file: string, args: readonly string[]) => Promise<{ stdout: string; code: number }>
  private readonly selfPid: number
  private cache: readonly ProcessMemory[] = []
  private cachedAt = Number.NEGATIVE_INFINITY
  private inFlight = false
  private lastError: string | null = null

  constructor(options: {
    readonly extraPids: readonly number[]
    readonly refreshMs?: number
    readonly selfPid?: number
    readonly runner?: (file: string, args: readonly string[]) => Promise<{ stdout: string; code: number }>
  }) {
    this.extraPids = options.extraPids
    this.refreshMs = options.refreshMs ?? 30_000
    this.selfPid = options.selfPid ?? process.pid
    this.runner = options.runner ?? runCapture
  }

  /** Every pid this reader considers part of the tree. */
  get pids(): readonly number[] {
    return [this.selfPid, ...this.extraPids]
  }

  /** Last error from the platform query, or `null`. */
  get error(): string | null {
    return this.lastError
  }

  /**
   * Total resident bytes for the tree.
   *
   * Returns the cached sum and, at most once per refresh window, starts a
   * background refresh. The refresh is deliberately fire-and-forget: a slow
   * `wmic` must not delay a health sample, and a stale-by-thirty-seconds sum is
   * still a perfectly good leak signal.
   *
   * @param nowMs - evaluation instant.
   * @param selfRssBytes - this process's RSS, always authoritative.
   */
  total(nowMs: number, selfRssBytes: number): number {
    if (nowMs - this.cachedAt >= this.refreshMs && !this.inFlight && this.extraPids.length > 0) {
      this.inFlight = true
      this.cachedAt = nowMs
      void this.refresh()
    }
    const others = this.cache.reduce((sum, entry) => sum + entry.rssBytes, 0)
    return selfRssBytes + others
  }

  private async refresh(): Promise<void> {
    try {
      const results: ProcessMemory[] = []
      if (process.platform === 'win32') {
        // One query for the whole list is cheaper than one per pid, and the pid
        // filter is applied here rather than on the command line so a missing pid
        // cannot make the query itself fail.
        const result = await this.runner('tasklist.exe', ['/NH', '/FO', 'CSV'])
        if (result.code !== 0) {
          this.lastError = `tasklist exited with ${result.code}`
        } else {
          const wanted = new Set(this.extraPids)
          for (const line of result.stdout.split(/\r?\n/)) {
            const parsed = parseTasklistMemoryLine(line)
            if (parsed !== null && wanted.has(parsed.pid)) results.push(parsed)
          }
        }
      } else {
        const result = await this.runner('ps', ['-o', 'pid=,rss=', '-p', this.extraPids.join(',')])
        if (result.code !== 0) {
          this.lastError = `ps exited with ${result.code}`
        } else {
          for (const line of result.stdout.split('\n')) {
            const parsed = parsePsMemoryLine(line)
            if (parsed !== null) results.push(parsed)
          }
        }
      }
      this.cache = results
      if (this.lastError === null && results.length !== this.extraPids.length) {
        this.lastError = `${this.extraPids.length - results.length} configured pid(s) are not running`
      }
    } catch (error) {
      this.lastError = (error as Error).message
    } finally {
      this.inFlight = false
    }
  }
}

/** Parse one `tasklist /NH /FO CSV` line into a pid and resident bytes. */
export function parseTasklistMemoryLine(line: string): ProcessMemory | null {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('INFO:')) return null
  const fields = trimmed.split(',').map((field) => field.trim().replace(/^"|"$/g, ''))
  if (fields.length < 5) return null
  const pid = Number(fields[1])
  // Memory is rendered like `1,234,567 K`, so the thousands separators are inside
  // the quoted field and must be stripped before the unit suffix is read.
  const memory = (fields.slice(4).join(',') ?? '').replace(/[,\s]/g, '')
  const match = /^(\d+(?:\.\d+)?)([KMG]?)B?$/i.exec(memory)
  if (!Number.isFinite(pid) || match === null) return null
  const value = Number(match[1])
  const unit = match[2]?.toUpperCase()
  const scale = unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : 1024
  return { pid, rssBytes: value * scale }
}

/** Parse one `ps -o pid=,rss=` line, where RSS is in kibibytes. */
export function parsePsMemoryLine(line: string): ProcessMemory | null {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
  if (match === null) return null
  return { pid: Number(match[1]), rssBytes: Number(match[2]) * 1024 }
}

/** Run a command and capture stdout without a shell. */
function runCapture(file: string, args: readonly string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error === null) {
          resolve({ stdout: String(stdout ?? ''), code: 0 })
          return
        }
        const code = typeof (error as unknown as { code?: number }).code === 'number'
          ? ((error as unknown as { code: number }).code as number)
          : 1
        resolve({ stdout: String(stdout ?? ''), code })
      },
    )
  })
}
