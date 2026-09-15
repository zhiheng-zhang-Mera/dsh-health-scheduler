/**
 * Shared vocabulary for the scenario suites.
 *
 * The action and reason names are asserted on by several suites, so they live in
 * one place: a rename in the engine then breaks exactly one file instead of five.
 */

export const ACTIONS = Object.freeze({
  none: 'NO_ACTION',
  throttle: 'THROTTLE',
  pause: 'PAUSE_NEW_WORK',
  appRestart: 'REQUEST_APP_RESTART',
  systemReboot: 'REQUEST_SYSTEM_REBOOT',
})

export const STATES = Object.freeze({
  healthy: 'HEALTHY',
  degraded: 'DEGRADED',
  throttled: 'THROTTLED',
  paused: 'PAUSED',
  maintenancePending: 'MAINTENANCE_PENDING',
  appRestart: 'REQUEST_APP_RESTART',
  escalationPending: 'ESCALATION_PENDING',
  systemReboot: 'REQUEST_SYSTEM_REBOOT',
  safeMode: 'SAFE_MODE',
})

/** The reason-code prefixes the engine is allowed to emit. */
export const REASONS = Object.freeze({
  prefixes: Object.freeze([
    'pressure_',
    'maintenance_',
    'safe_point_',
    'hysteresis_',
    'dwell_',
    'debounce_',
    'coverage_',
    'urgent_override',
    'restart_capability_unavailable',
    'system_reboot_requires_restart_adapter',
    'min_repeat_action_interval',
    'throttle_cooldown',
    'maintenance_cooldown',
    'escalation_cooldown',
    'escalation_overrides_safe_point',
    'escalation_from_repeated_app_restart_failure',
    'uptime_pressure',
  ]),
})

/** A wall clock helper: `HH:MM` for a shifted instant. */
export function clockOf(epochMs) {
  const date = new Date(epochMs)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/**
 * Put the rig inside its maintenance window.
 *
 * Anchors the scenario epoch to a local 03:45 so the default 03:30-05:00 window
 * is open and the 04:00 target is still ahead; the caller then advances past the
 * target to reach the decision point.
 */
export function withinMaintenanceWindow(rig) {
  const date = new Date(rig.now)
  date.setHours(3, 45, 0, 0)
  rig.now = date.getTime()
  return rig
}

/**
 * Drive a rig through a scripted period, ticking at `tickMs`.
 *
 * @param rig - a {@link ScenarioRig}.
 * @param options - `minutes` of scenario time, `tickMs` per tick, optional
 *   `maintenanceWindow` to anchor the clock, and an optional `onTick` hook that
 *   may mutate providers before each tick.
 */
export async function drive(rig, options) {
  const tickMs = options.tickMs ?? 15_000
  const totalMs = Math.round((options.minutes ?? 1) * 60_000)
  if (options.maintenanceWindow === true) withinMaintenanceWindow(rig)
  const steps = Math.max(1, Math.round(totalMs / tickMs))
  const snapshots = []
  for (let step = 0; step < steps; step += 1) {
    if (typeof options.onTick === 'function') options.onTick(step, rig)
    const batch = await rig.advance(tickMs, 1)
    snapshots.push(...batch)
  }
  return snapshots
}
