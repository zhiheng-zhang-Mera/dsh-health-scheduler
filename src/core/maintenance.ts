/**
 * Maintenance scheduling.
 *
 * The design is explicit about what this must *not* be: `04:00 -> reboot`.
 * A maintenance decision is a window plus a target plus pressure plus a safe
 * point, and the only thing this module decides is whether a restart may be
 * *requested right now*. It never performs one.
 *
 * ```
 *   outside_window   before_target   at_target   deferred   overdue   urgent_override
 * ```
 *
 * @module dsh-health-scheduler/core/maintenance
 */

import type { MaintenanceConfig } from '../types/config.js'
import type { MaintenancePhase, MaintenancePicture } from '../types/decision.js'

/** Milliseconds in one day. */
const DAY_MS = 24 * 3_600_000

/** Parse `HH:MM` into milliseconds after local midnight. */
export function parseClock(text: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text)
  if (match === null) throw new Error(`invalid wall-clock time: ${JSON.stringify(text)}`)
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000
}

/** Local midnight of the day containing `atMs`. */
export function startOfLocalDay(atMs: number): number {
  const date = new Date(atMs)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * The most recent instant at or before `atMs` whose local wall clock equals
 * `hhmm`. Correct across DST shifts because it works on local calendar dates
 * rather than by adding fixed offsets.
 */
export function previousOccurrence(hhmm: string, atMs: number): number {
  const target = parseClock(hhmm)
  const dayStart = startOfLocalDay(atMs)
  const candidate = dayStart + target
  return candidate <= atMs ? candidate : candidate - DAY_MS
}

/** The next instant strictly after `atMs` whose local wall clock equals `hhmm`. */
export function nextOccurrence(hhmm: string, atMs: number): number {
  const previous = previousOccurrence(hhmm, atMs)
  return previous === atMs ? atMs : previous + DAY_MS
}

/** Whether a wall-clock span `[start, end)` contains `hhmm`, tolerating wrap. */
export function clockWithin(hhmm: string, start: string, end: string): boolean {
  const t = parseClock(hhmm)
  const s = parseClock(start)
  const e = parseClock(end)
  if (s <= e) return t >= s && t < e
  // Window wraps past midnight, e.g. 23:00..02:00.
  return t >= s || t < e
}

/** Format an instant as local `HH:MM`, for evidence strings. */
export function formatClock(atMs: number): string {
  const date = new Date(atMs)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Format a duration as `Xh Ym` / `Ym Zs`, for evidence strings. */
export function formatDuration(ms: number): string {
  const abs = Math.max(0, Math.round(ms))
  const hours = Math.floor(abs / 3_600_000)
  const minutes = Math.floor((abs % 3_600_000) / 60_000)
  const seconds = Math.round((abs % 60_000) / 1000)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Where the maintenance window stands, computed without any pressure input.
 *
 * @param config - maintenance configuration.
 * @param nowMs - evaluation instant.
 * @param deferredSinceMs - when the current target first became deferrable, or
 *   `null` when the scheduler has not deferred anything yet.
 * @param pressure - current restart pressure, for the urgent-override check.
 */
export function computeMaintenancePicture(
  config: MaintenanceConfig,
  nowMs: number,
  deferredSinceMs: number | null,
  pressure: number | null,
): MaintenancePicture {
  if (!config.enabled) {
    return {
      phase: 'outside_window',
      windowOpen: false,
      nextTargetAt: null,
      windowClosesInMs: 0,
      deferredMs: 0,
      deferExhausted: false,
      urgentOverride: false,
      summary: 'scheduled maintenance is disabled',
    }
  }

  const today = startOfLocalDay(nowMs)
  const windowStartMs = today + parseClock(config.windowStart)
  const windowEndMs = today + parseClock(config.windowEnd)
  const wraps = parseClock(config.windowEnd) <= parseClock(config.windowStart)

  // Resolve the window instance that is either open now or opens next.
  let openStart = windowStartMs
  let openEnd = wraps ? windowEndMs + DAY_MS : windowEndMs
  if (nowMs >= openEnd) {
    openStart += DAY_MS
    openEnd += DAY_MS
  } else if (nowMs < openStart) {
    // Not open yet today; the instance starting today is still ahead.
  }

  const targetMs = openStart + (parseClock(config.targetTime) - parseClock(config.windowStart))
  const windowOpen = nowMs >= openStart && nowMs < openEnd
  const deferredMs =
    deferredSinceMs === null ? 0 : Math.max(0, Math.min(nowMs, openEnd) - deferredSinceMs)
  const deferExhausted = deferredSinceMs !== null && deferredMs >= config.maxDeferMs
  const urgentOverride =
    config.urgentOverridePressure !== null &&
    pressure !== null &&
    pressure >= config.urgentOverridePressure

  let phase: MaintenancePhase
  if (urgentOverride) {
    phase = 'urgent_override'
  } else if (!windowOpen) {
    phase = 'outside_window'
  } else if (nowMs < targetMs) {
    phase = 'before_target'
  } else if (nowMs === targetMs) {
    phase = 'at_target'
  } else if (deferExhausted) {
    phase = 'overdue'
  } else {
    phase = 'deferred'
  }

  const summary =
    phase === 'outside_window'
      ? `next window ${formatClock(openStart)}-${formatClock(openEnd)}`
      : phase === 'before_target'
        ? `window open, target at ${config.targetTime}`
        : phase === 'at_target'
          ? `target ${config.targetTime} reached`
          : phase === 'deferred'
            ? `deferred ${formatDuration(deferredMs)} of ${formatDuration(config.maxDeferMs)}`
            : phase === 'overdue'
              ? `max defer exhausted (${formatDuration(deferredMs)})`
              : `urgent override at pressure ${pressure}`

  return {
    phase,
    windowOpen,
    nextTargetAt: new Date(targetMs).toISOString(),
    windowClosesInMs: Math.max(0, openEnd - nowMs),
    deferredMs,
    deferExhausted,
    urgentOverride,
    summary,
  }
}

/** Whether the picture allows a maintenance restart request to be raised. */
export function maintenanceAllowsRequest(picture: MaintenancePicture, config: MaintenanceConfig): boolean {
  if (!config.enabled || !config.allowAppRestart) return false
  if (picture.phase === 'urgent_override') return true
  if (!picture.windowOpen) return false
  return picture.phase !== 'before_target'
}
