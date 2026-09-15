# Policies: the action ladder, anti-flapping and maintenance

[English](policies.md) | [中文](policies.zh.md)

The policy engine (`src/core/policy.ts`) answers one question per tick: *what should happen
now?* It reads a pressure number and a maintenance picture, applies hysteresis, debounce, dwell
and cooldown rules, and emits at most one action. It never touches a process, a queue or a
device, and it keeps no state of its own beyond what the scheduler hands back to it.

## The action ladder

`DECISION_LADDER` and `ACTION_LEVEL` fix the vocabulary and the ordering:

| Level | Action | `ACTION_LEVEL` | Who performs it |
| --- | --- | --- | --- |
| 0 | `NO_ACTION` | 0 | nobody |
| 1 | `THROTTLE` | 1 | this plugin, via `WorkerControlAdapter.setConcurrencyLimit` |
| 2 | `PAUSE_NEW_WORK` | 2 | this plugin, via `WorkerControlAdapter.pauseNewWorkers` |
| 3 | `REQUEST_APP_RESTART` | 3 | **`dsh-restart`**, via `RestartAdapter.requestApplicationRestart` |
| 4 | `REQUEST_SYSTEM_REBOOT` | 4 | **`dsh-restart`**, via `RestartAdapter.requestSystemRestart` |

The name is `REQUEST_SYSTEM_REBOOT`, not `REQUEST_SYSTEM_RESTART`. The adapter method is
`requestSystemRestart` and the request's `mode` is `'system'`; only the action name says
reboot.

`resolveConfig` enforces two ordering rules on the ladder and rejects a document that breaks
either:

- every rung's `enter` must be **strictly above** the previous rung's `enter`;
- every rung's `exit` must **not fall below** the previous rung's `exit`.
- Each band individually must satisfy `exit < enter`.

### Enter and exit bands for all three presets

| Rung | conservative enter/exit | balanced enter/exit | aggressive enter/exit |
| --- | --- | --- | --- |
| `THROTTLE` | 47 / 38 | 55 / 45 | 63 / 52 |
| `PAUSE_NEW_WORK` | 60 / 51 | 70 / 60 | 81 / 69 |
| `REQUEST_APP_RESTART` | 68 / 58 | 80 / 68 | 92 / 78 |
| `REQUEST_SYSTEM_REBOOT` | 81 / 72 | 95 / 85 | 99 / 98 |

The aggressive reboot rung enters at 99 and exits at 98, so on `aggressive` level 4 requires an
essentially saturated model. `PRESET_SCALES.aggressive.bands = 1.15` would produce 109 from a
base of 95, so `scalePreset` caps every entry at 99: a rung nobody can reach is a rung that has
silently been deleted, and "only when the model is pinned at maximum" is a defensible aggressive
policy whereas "never" is not. The same cap keeps every preset's ladder strictly increasing, and
`resolveConfig` re-validates that ordering, so a hand-written override that inverts it is
rejected rather than accepted.

### Verified ladder behaviour

Running `PolicyEngine.evaluate` on the balanced preset with debounce, dwell and repeat
intervals disabled, from a fresh state each time, maintenance disabled:

| Pressure | Candidate | Effective action | Resulting state |
| --- | --- | --- | --- |
| 0 / 40 / 45 | `NO_ACTION` | `NO_ACTION` | `HEALTHY` |
| 50 / 54 | `NO_ACTION` | `NO_ACTION` | `DEGRADED` |
| 55 / 60 / 69 | `THROTTLE` | `THROTTLE` | `THROTTLED` |
| 70 / 79 | `PAUSE_NEW_WORK` | `PAUSE_NEW_WORK` | `PAUSED` |
| 80 / 84 / 94 | `REQUEST_APP_RESTART` | **`PAUSE_NEW_WORK`** | `MAINTENANCE_PENDING` |
| 95 / 100 | `REQUEST_SYSTEM_REBOOT` | **`PAUSE_NEW_WORK`** | `ESCALATION_PENDING` |
| `null` | `NO_ACTION` | `NO_ACTION` | `DEGRADED` |

The pattern in the last three rows is the whole design in one table: **the ladder can ask for a
restart, but the restart gate decides whether the request is actually raised.** With the
maintenance window closed — the default — a level-3 or level-4 decision is downgraded to
`PAUSE_NEW_WORK`, and the state machine records the pending intent rather than forgetting it.

The rungs are evaluated top-down, so the highest satisfied `enter` wins. Note that pressure 50
gives `NO_ACTION` but state `DEGRADED`: the state machine's health test is the *throttle exit*
band, not the throttle enter band.

## Hysteresis

An active action is only released once pressure falls through **its own** exit band:

```ts
const activeBand = ladder.find(([action]) => action === previous.action)?.[1]
if (activeBand !== undefined && pressure > activeBand.exit) {
  hysteresisHeld = true
  candidate = { action: previous.action, reasons: ['hysteresis_holds_active_action'] }
}
```

`hysteresisHeld` is reported on the `DecisionEvaluation` so a consumer can see that the action
in force is being held rather than re-justified. Two limits worth knowing:

- Hysteresis only applies when the raw candidate is `NO_ACTION`. If pressure climbs past a
  *higher* rung the ladder escalates immediately — hysteresis does not slow escalation, only
  release.
- Hysteresis holds the previous action while `pressure > exit`, strictly. At exactly `exit`
  the action is released.

`tests/policy.test.js` has a dedicated case: a series of `56, 54, 56, 54, …` produces
`THROTTLE` on every evaluation, because 54 is still above the 45 exit band.

## Debounce

```ts
if (ACTION_LEVEL[candidate.action] > activeLevel &&
    ACTION_LEVEL[candidate.action] >= ACTION_LEVEL.REQUEST_APP_RESTART &&
    antiFlap.debounceEvaluations > 1 &&
    consecutiveCandidate < antiFlap.debounceEvaluations) { … }
```

Three properties make this narrower than "everything is debounced":

1. It only applies to **upward crossings** — a candidate strictly above the action in force.
2. It only applies at level 3 and above. Levels 1 and 2 are never debounced.
3. It only applies to a **new** level. The counter tracks the raw candidate, and it is
   incremented only when the candidate differs from the action currently in force:

   ```ts
   consecutiveCandidate = candidate.action === previous.candidate
     ? previous.consecutiveCandidate + (candidate.action === previous.action ? 0 : 1)
     : 1
   ```

   So a candidate that keeps repeating while nothing has been applied still accumulates, but an
   action already in force does not re-accumulate. With the default
   `debounceEvaluations: 2`, the first evaluation of a newly critical machine yields
   `NO_ACTION` with a `debounce_request_system_reboot_1_of_2` reason; the second acts.

4. It never *lowers* an action. A debounced candidate keeps `previous.action`, which is a
   de-escalation only in the sense that nothing new happened.

## Dwell

```ts
if (effective.action !== previous.action &&
    ACTION_LEVEL[effective.action] < ACTION_LEVEL.REQUEST_APP_RESTART &&
    ACTION_LEVEL[previous.action] < ACTION_LEVEL.REQUEST_APP_RESTART &&
    dwellElapsed < antiFlap.minStateDwellMs) { … }
```

Dwell is the mirror image of debounce: it slows transitions **below** level 3, in either
direction, and it does not apply when either side of the transition is a restart level. So a
recovery from `THROTTLED` back to `NO_ACTION` waits out the dwell time, while the first
crossing out of `NO_ACTION` is never delayed — the guard requires `previous.action` to also be
below level 3, and `NO_ACTION` is level 0, so the first crossing *is* subject to dwell only if
something else changed state first. In practice the first `THROTTLE` out of a fresh
`NO_ACTION` is applied immediately, and `tests/policy.test.js` asserts exactly that.

`dwellElapsed` is measured from `previous.sinceMs`, which the policy engine moves forward only
on an actual change of action or state.

## The three cooldowns

| Cooldown | Bucket | Balanced default | Kinds that use it |
| --- | --- | --- | --- |
| `cooldowns.throttleMs` | `throttle` | 5 min | `THROTTLE`, `PAUSE_NEW_WORK` |
| `cooldowns.maintenanceMs` | `maintenance` | 30 min | `REQUEST_APP_RESTART` |
| `cooldowns.escalationMs` | `escalation` | 60 min | `REQUEST_SYSTEM_REBOOT`, and `NO_ACTION` |

`cooldownKindOf` maps an action to its bucket; `cooldownMsOf` maps a bucket to its duration.
`NO_ACTION` maps to `escalation` by falling through the `switch` default, but the cooldown is
never consulted for `NO_ACTION`, so the mapping is inert.

### The cooldown starts on the attempt, not the decision

This is the part that is easy to get wrong, and the code is explicit about why:

```ts
// src/core/scheduler.ts
private noteAttempt(action: DecisionAction, atMs: number): void {
  if (action === 'NO_ACTION') return
  const kind = cooldownKindOf(action)
  this.attempts = {
    lastAttemptAt: atMs,
    lastAttemptAction: action,
    cooldowns: { ...this.attempts.cooldowns, [kind]: atMs + cooldownMsOf(this.config, action) },
  }
}
```

`noteAttempt` is called whenever `applyAction` returned a non-`null` outcome — **including when
the adapter refused or threw**. The comment in the source states the reasoning: the cooldown
exists to pace the *capability*, so a refusal must start it too. Without that, a missing
`dsh-restart`, or a restart adapter that always rejects, would produce one request per tick.

The scheduler additionally enforces a repeat guard *at the point of action*:

```ts
if (action === this.attempts.lastAttemptAction && cooldownUntil > this.clock()) return null
```

so an identical action is not even re-attempted while its bucket is cooling. This is what
bounds `tests/scenarios.test.js`'s 30-minute, 120-evaluation, permanently-critical scenario to
at most 3 adapter calls.

### Repeat suppression versus de-escalation

The asymmetry is deliberate and stated in the source:

- A suppressed **repeat** suppresses the action: `repeatSuppressed` is true only when the
  effective action equals the previous action, and the action recorded for the state machine
  becomes `NO_ACTION`.
- A suppressed **de-escalation** is merely delayed: pressure falling below the exit band is
  never blocked by a cooldown.

`minRepeatActionMs` is a fourth, independent pacing rule: the same action as the last attempt
is suppressed while `nowMs - lastAttemptAt < antiFlap.minRepeatActionMs`, regardless of the
bucket cooldown.

### Cooldown reasons

| Reason string | Meaning |
| --- | --- |
| `throttle_cooldown_active` / `maintenance_cooldown_active` / `escalation_cooldown_active` | The bucket is still cooling and the action is a repeat. |
| `throttle_cooldown_delays_transition` / … | The bucket is still cooling but the action differs from the one in force, so it is only delayed. |
| `min_repeat_action_interval` | The same action as the last attempt, inside `minRepeatActionMs`. |

`DecisionEvaluation.cooldownActive`, `.cooldownKind` and `.cooldownRemainingMs` carry the same
information in structured form.

## The restart gate

A restart is a request, not a right. `gateRestart` runs whenever the effective action is
level 3 or 4, and can block it and downgrade to `PAUSE_NEW_WORK`:

| Condition | Blocked? | Reason added |
| --- | --- | --- |
| `restartCapability !== 'available'` | yes | `restart_capability_unavailable` |
| action is level 4 and capability is unavailable | yes | `system_reboot_requires_restart_adapter` |
| `maintenance.urgentOverride` is true | **no** | `urgent_override_active` |
| window is closed | yes | `maintenance_window_closed`, `maintenance_<phase>` |
| window is open but `phase === 'before_target'` | yes | `maintenance_before_target_time` |
| safe point `safe === true` | no | `safe_point_confirmed`, `safe_point_<state>` |
| safe point `safe === false` | yes | `safe_point_unsafe`, `safe_point_reason_<reason>` |
| safe point `safe === null` (unknown) | yes | `safe_point_unknown`, `safe_point_reason_<reason>` |
| `readiness` is `null` (safe point not required) | no | nothing |

Two exemptions, both narrow and both non-silent:

- **The urgent override skips the window**, which is the design's scenario C. It does *not*
  skip the safe point.
- **Only level 4 can override the safe point**, and only when the urgent override is also
  active:

  ```ts
  const escalateAnyway = action === 'REQUEST_SYSTEM_REBOOT' && input.maintenance.urgentOverride
  if (blocked && escalateAnyway && input.restartCapability === 'available') {
    return { blocked: false, reasons: [...reasons, 'escalation_overrides_safe_point'], … }
  }
  ```

  The reason list then contains the blocking reasons *and* `escalation_overrides_safe_point`,
  so the audit trail always says the safe point was not confirmed. Note that the restart
  capability is still required — the override bypasses the safe point and the window, never the
  absence of a restart adapter.

The gate is only consulted when the effective action is a restart. If the ladder produced
`THROTTLE` or `PAUSE_NEW_WORK`, the gate does not run and does not add reasons.

## Dispatch: metrics to dimensions

`dimensionOf` maps a canonical metric name to one of the six pressure dimensions through a
frozen table in `src/core/pressure.ts`. The mapping is not the same as the metric's registry
*group*, which matters for two metrics:

| Metric | Registry group | Pressure dimension |
| --- | --- | --- |
| `task_failure_rate` | `context` | **`worker`** |
| `git_operations_per_minute` | `context` | **`time`** |
| `ipc_timeout_rate` | `runtime` | `runtime` |
| `uptime_seconds` | `runtime` | **`time`** |

Everything else maps to the dimension of the same name: `hardware` metrics to `thermal`,
`memory` to `memory`, `runtime` to `runtime`, `workers` to `worker`, `computer-use` and `ui` to
`computer_use_ui`.

**Memory metrics are not double-counted into runtime.** The design's "runtime degradation"
list includes "process handle growth" and "thread growth", and it would be natural to also fold
`process_rss_bytes` into runtime. The code deliberately does not:

```ts
// `runtime` metrics stay visible through the runtime dimension; the memory
// dimension owns only real memory telemetry. Handle and thread growth reaches
// pressure as explicit runtime-degradation drivers in the policy layer rather
// than by being double-counted here.
```

So `handle_count` and `thread_count` reach pressure **only** through the `runtime` dimension and
**only** through their trend terms. `process_rss_bytes` and `process_private_bytes` reach it
**only** through the `memory` dimension. `ram_total_bytes`, a sizing fact, is not scored at all.

## Safe-point folding

A safe point answers "is now a good moment?". The scheduler asks and does not store the answer.

`SafePointRegistry.readiness(timeoutMs = 1000)` asks every registered source concurrently. A
source that throws becomes `{safe: null, reason: 'safe_point_source_failed'}`; a source that
does not answer within the per-source budget becomes
`{safe: null, reason: 'safe_point_timeout'}`. Neither delays the tick past the budget.

`foldReadiness` then reduces the readings, worst-first:

| Input | `safe` | `reason` | `estimated_state` |
| --- | --- | --- | --- |
| no sources registered | `null` | `no_safe_point_source` | `unknown` |
| any source says `false` | `false` | that source's reason | the worst state any source reported |
| no `false`, any `null` | `null` | that source's reason | `unknown` |
| all say `true` | `true` | `safe_point_reached` | the worst state any source reported |

`estimated_state` uses `STATE_RANK = { idle: 0, busy: 1, critical: 2, unknown: 3 }`, so
`unknown` ranks as the busiest state for presentation purposes. Note the asymmetry in the table:
when something is unsafe, `estimated_state` reflects the worst state reported by *any* source;
when something is merely unknown, the state is forced to `unknown`.

The one rule that matters: **an unanswered question is not a `yes`.** With
`maintenance.safePointRequired: true` (the default) and no source registered, a level-3 request
is blocked with `safe_point_unknown`. That is why the balanced default of
`maintenance.enabled: false` and `safePointRequired: true` is coherent rather than
contradictory: with maintenance disabled the whole gate is bypassed at the window step, and
the safe point never becomes the reason a request is blocked.

When `safePointRequired: false`, the scheduler does not even call the registry — it synthesises
`{safe: null, reason: 'safe_point_not_required'}` and passes that as `readiness`. Because the
gate treats `null` readiness as "do not ask", the safe point is skipped entirely.

## The maintenance window state machine

`maintenanceAllowsRequest(picture, config)` is the coarse answer:

```ts
if (!config.enabled || !config.allowAppRestart) return false
if (picture.phase === 'urgent_override') return true
if (!picture.windowOpen) return false
return picture.phase !== 'before_target'
```

Note that the policy engine does **not** call this function — it re-implements the same
conditions in `gateRestart` so it can attach reasons. `maintenanceAllowsRequest` is the library
convenience for embedders and is exercised by `tests/maintenance.test.js`.

### Phases

`computeMaintenancePicture` resolves the window instance that is either open now or opens next,
computes the target as `windowStart + (targetTime - windowStart)` on that instance, and then
picks a phase:

| Phase | Condition | `windowOpen` | Request allowed |
| --- | --- | --- | --- |
| `urgent_override` | pressure ≥ `urgentOverridePressure` (and it is not `null`) | irrelevant | **yes**, window ignored |
| `outside_window` | `now` is not inside the window | `false` | no |
| `before_target` | inside the window, `now < target` | `true` | **no** |
| `at_target` | inside the window, `now === target` | `true` | yes |
| `deferred` | past the target, deferral budget remains | `true` | yes |
| `overdue` | past the target, `deferExhausted` | `true` | yes — "go now", not "give up" |

The urgent-override test is evaluated **first**, so an urgent machine inside the window also
reports `urgent_override` rather than `at_target`.

Other fields on `MaintenancePicture`:

- `nextTargetAt` — ISO-8601 of the target, or `null` when maintenance is disabled.
- `windowClosesInMs` — milliseconds until the window closes, `0` once it has. Computed as
  `max(0, openEnd - now)`.
- `deferredMs` — `max(0, min(now, openEnd) - deferredSinceMs)`, so deferral never counts past
  the end of the window.
- `deferExhausted` — `deferredSinceMs !== null && deferredMs >= maxDeferMs`.
- `urgentOverride` — the same test that produces the phase.
- `summary` — a human line, e.g. `deferred 40m 0s of 1h 0m` or `next window 03:30-05:00`.

### Verified phases

Balanced defaults (`targetTime 04:00`, window `03:30`–`05:00`, `maxDeferMs` 60 min,
`urgentOverridePressure` 92):

| Local time | `deferredSince` | Pressure | Phase | `windowOpen` | `deferredMs` |
| --- | --- | --- | --- | --- | --- |
| 02:00 | `null` | 10 | `outside_window` | `false` | 0 |
| 03:45 | `null` | 10 | `before_target` | `true` | 0 |
| 04:00 | `null` | 10 | `at_target` | `true` | 0 |
| 04:10 | 04:00 | 10 | `deferred` | `true` | 600 000 |
| 04:40 | 04:00 | 10 | `deferred` | `true` | 2 400 000 |
| 14:00 | `null` | 93 | `urgent_override` | `false` | 0 |
| 14:00 | `null` | 91 | `outside_window` | `false` | 0 |

### Deferral ledger

The picture is computed without any memory; `HealthScheduler` owns the `deferredSinceMs`
ledger. It is set the first time a tick sees an open window and is cleared when a closed window
is observed with `windowClosesInMs === 0`:

```ts
if (picture.windowOpen && this.deferredSinceMs === null) {
  this.deferredSinceMs = Math.max(nextTargetAt === null ? nowMs : Date.parse(nextTargetAt), nowMs)
}
if (!picture.windowOpen && picture.phase === 'outside_window' && (this.deferredSinceMs ?? 0) > 0) {
  if (picture.windowClosesInMs === 0) this.deferredSinceMs = null
}
```

The ledger is in memory only. A scheduler restart begins deferring again from the start of the
next window.

### Wall-clock arithmetic

The window is expressed in local calendar fields, never as a fixed millisecond offset, so it
survives DST. `startOfLocalDay` + `parseClock` constructs each instant; `clockWithin` handles a
window that wraps past midnight (`23:00`–`02:00`); `previousOccurrence` and `nextOccurrence`
find the surrounding occurrences of an `HH:MM`. `tests/maintenance.test.js` pins a
spring-forward-style day boundary across four separate days.

## The state machine

`stateFor` derives `MachineState` from the action in force *and* the context, which is how a
gated restart stays visible:

| Effective action | Context | State |
| --- | --- | --- |
| `NO_ACTION` | raw action was a gated level 3 | `MAINTENANCE_PENDING` |
| `NO_ACTION` | raw action was a gated level 4 | `ESCALATION_PENDING` |
| `NO_ACTION` | previous state was `REQUEST_SYSTEM_REBOOT` | `SAFE_MODE` |
| `NO_ACTION` | pressure `null` | `DEGRADED` (or the previous state if it was already `HEALTHY`) |
| `NO_ACTION` | pressure ≤ `thresholds.throttle.exit` | `HEALTHY` |
| `NO_ACTION` | otherwise | `DEGRADED` |
| `THROTTLE` | gated level 4 | `ESCALATION_PENDING` |
| `THROTTLE` | gated level 3 | `MAINTENANCE_PENDING` |
| `THROTTLE` | otherwise | `THROTTLED` |
| `PAUSE_NEW_WORK` | gated level 3 / gated level 4 | `MAINTENANCE_PENDING` / `ESCALATION_PENDING` |
| `PAUSE_NEW_WORK` | otherwise | `PAUSED` |
| `REQUEST_APP_RESTART` | — | `REQUEST_APP_RESTART` |
| `REQUEST_SYSTEM_REBOOT` | — | `REQUEST_SYSTEM_REBOOT` |

Two subtleties:

- `MAINTENANCE_PENDING` and `ESCALATION_PENDING` are the "we want to restart but cannot"
  states, and they are reachable with `THROTTLE` as the action in force, not just
  `PAUSE_NEW_WORK`.
- The `NO_ACTION` / pressure-`null` row is odd on purpose and slightly counter-intuitive: it
  returns `DEGRADED` only when the previous state was `HEALTHY`, and otherwise keeps whatever
  state was already held. The intent is that losing all telemetry must not be reported as
  `HEALTHY`, and the implementation achieves that without discarding a state that already said
  something worse.
- `SAFE_MODE` is reachable only from a previous `REQUEST_SYSTEM_REBOOT`, i.e. after a system
  restart was actually requested and pressure has since come down. It is a terminal calm state,
  not an error state.

## Reason codes

Every decision carries a de-duplicated, order-preserving reason list. The engine emits only
these prefixes:

| Prefix | Examples |
| --- | --- |
| `pressure_` | `pressure_84_gte_app_restart_80` |
| `maintenance_` | `maintenance_window_closed`, `maintenance_deferred`, `maintenance_before_target_time` |
| `safe_point_` | `safe_point_confirmed`, `safe_point_unsafe`, `safe_point_unknown`, `safe_point_reason_git_commit_in_progress` |
| `hysteresis_` | `hysteresis_holds_active_action` |
| `dwell_` | `state_dwell_15s_of_120s`, `dwell_suppressed_transition` |
| `debounce_` | `debounce_request_system_reboot_1_of_2` |
| `coverage_` | `coverage_60pct` |
| `throttle_cooldown` / `maintenance_cooldown` / `escalation_cooldown` | `…_active`, `…_delays_transition` |
| `min_repeat_action_interval` | — |
| `urgent_override_active` | — |
| `restart_capability_unavailable` | — |
| `system_reboot_requires_restart_adapter` | — |
| `escalation_overrides_safe_point` | — |
| `escalation_from_repeated_app_restart_failure` | attached to every level-4 candidate |
| `uptime_pressure` | a driver code, not a reason prefix, but listed in the test vocabulary |
| driver codes | the top three driver codes are appended to every `pressure_*` candidate |

`coverage_NNpct` is appended to **every** decision, which means a consumer can always tell how
much of the model was actually measured at the moment of the decision.

`escalation_from_repeated_app_restart_failure` is worth calling out: it is attached to every
level-4 candidate unconditionally, but nothing in the engine actually verifies that an app
restart previously failed. There is no escalation counter and no restart-outcome feedback loop
in `0.1.0` — the escalation happens purely because pressure crossed the level-4 enter
threshold. The reason string overstates what the engine knows.

## What the policy engine does not do

- It does not apply the action. `PolicyEngine.evaluate` is pure: given inputs and previous
  state it returns a decision and the next state, and `HealthScheduler.applyAction` is the only
  place an adapter is invoked.
- It does not own the cooldowns. The attempt log lives in the scheduler because only the
  scheduler knows whether an adapter was really called.
- It does not store task state, run a checkpoint or hold a lock. Those belong to DS-Hns Core and
  `dsh-restart`.
- It does not read the clock itself. `nowMs` and `timestamp` arrive as inputs, which is what
  makes `tests/policy.test.js` able to drive it deterministically.
