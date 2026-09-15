# Security policy

## Supported versions

`dsh-health-scheduler` is at `0.1.0` and has no released support matrix yet. Security fixes are
applied to the `main` line; there are no maintained back-port branches. If you are running a
pinned version, be prepared to move forward to receive a fix.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities)
on the repository, or by email to the maintainer address listed in the repository profile.

Please include:

- affected version or commit, and the DSH profile you reproduced it in,
- the platform (Windows version, or Linux distribution) and Node version,
- the configuration document involved, with anything sensitive redacted,
- a minimal reproduction — the smallest helper command, stats file or config that triggers it,
- what an attacker gains, and what they need in order to try (write access to a path? the
  ability to influence path selection? a crafted metric name?),
- whether the issue also affects a default, unconfigured install.

What to expect: an acknowledgement within about seven days, an assessment of severity and
affected versions, and credit in the release notes if you want it. This is a community project
maintained on a best-effort basis; there is no bug bounty.

## Threat model

### What this plugin is

A read-mostly telemetry collector that runs **inside your harness process**, with your
privileges, in the profile you installed it into. It samples the machine, keeps bounded rolling
history in memory, optionally appends a bounded JSONL audit log, and asks adapters to throttle
workers or request a restart.

It is **not** a sandbox, a privilege boundary, or a trusted component in a hostile multi-tenant
deployment. Installing it means running its code with your rights, exactly like any other
plugin.

### What it has access to

| Resource | Access | Notes |
| --- | --- | --- |
| Process-global Node APIs | read | `os.cpus()`, `os.totalmem()`, `os.freemem()`, `os.uptime()`, `os.platform()`, `os.arch()`, `os.hostname()`, `os.release()`, `process.memoryUsage()`, `process.uptime()`, `process.getActiveResourcesInfo()`. The `OsFacade` also exposes `os.loadavg()`, but no built-in provider calls it. |
| Files | **read** for stats files, heartbeat files and the decision log; **write** for the decision log only | No other path is opened. |
| Subprocesses | one configured `execFile` per probe, plus one helper command | Without a shell. See below. |
| Network | **none** | The plugin makes no network calls of any kind. It has no HTTP client, no socket, no DNS use. |
| Environment | inherited from the harness process | Passed to helper commands and probes. |
| Harness context | `tools.register`, `settings.register`, `logger`, `effect`, and the optional `ctx.healthScheduler` adapter | Structurally typed; a missing service is handled. |
| Worker-control / restart adapters | an object the harness or another plugin put on the context | This plugin can only call the methods the adapter exposes. It has no restart ability of its own. |

### Assets worth protecting

1. **Integrity of the decision path.** A forged metric could make the plugin throttle a healthy
   machine, or hide a sick one. Neither is catastrophic, but the second is the more serious: it
   means a real problem goes unattended.
2. **The helper command as a privilege amplifier.** `helperCommand` runs with your rights. If an
   attacker can change that configuration or the executable it points at, they get code
   execution with your privileges — but they already have whatever access was needed to change
   it.
3. **Confidentiality of what is collected.** Hostname, CPU/GPU model, memory totals, process
   memory, and whatever an integration writes into a stats file. None of it is transmitted
   anywhere by this plugin, but it *is* returned in tool output and therefore lands in session
   transcripts.
4. **Availability of the host process.** A probe that hangs, a stats file that grows, or a
   decision log on a slow disk must not take the harness down or turn into a spin loop.

### Attack surfaces, in the order they deserve attention

#### 1. `execFile` for helper commands and probes — the main one

`runCommandProbe` (`src/providers/sources.ts`) is the only place this plugin starts a process:

```ts
execFile(file, args, { timeout: config.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, cb)
```

Properties that matter, and their limits:

- **No shell.** `execFile` does not go through `cmd.exe` or `/bin/sh`, so a metric value or a
  file name cannot be turned into shell metacharacters. This is deliberate and is why `exec`
  and `execSync` must never be introduced here.
- **No shell means no quoting rescue, but also no quoting hazard**: arguments are passed as an
  argv array, so a value containing spaces or `&` is one argument. Argument *injection* is still
  possible in the sense that whoever writes the config chooses the arguments — the config is
  trusted input, not untrusted input.
- **`PATH` resolution.** With `helperCommand: ['powershell', …]` the executable is resolved
  through `PATH`/`PATHEXT`. Any process that can write to a directory earlier on `PATH` than the
  real `powershell.exe` can therefore substitute it. This is the classic PATH-hijack shape and
  it is not mitigated by the plugin: **use an absolute path in `helperCommand` if `PATH` is not
  fully under your control.** Note that on a typical Windows install the current directory is
  not searched for `execFile`, but every `PATH` entry is.
- **Inherited environment.** The child inherits the harness's environment. A helper that leaks
  its environment into a stats file it writes would leak credentials; that is the helper's
  problem, but it is worth knowing before pointing one at an authenticated source.
- **Timeouts and output bounds.** `timeoutMs` kills the child; `maxBuffer` is 1 MiB, so a
  runaway command cannot exhaust memory through stdout. A command that ignores the timeout kill
  (for example one that has spawned its own detached grandchildren) is not further contained —
  the plugin does not kill process trees.
- **`windowsHide: true`** only suppresses the console window.
- **Non-zero exit is not distinguished from tampering.** Any failure becomes a degraded sample,
  which scores as `unknown`. An attacker who can make a probe fail can *hide* a problem
  (downgrading a real reading to unknown) but cannot make the plugin believe a fabricated
  healthy value if the probe is the only source.

**Practical guidance:** treat `helperCommand` and `statsFile.commands` as privileged
configuration. Pin absolute paths, keep the scripts themselves out of world-writable directories,
and keep `-ExecutionPolicy Bypass` scoped to a script you wrote.

#### 2. Stats-file ingestion

`StatsFileSource` reads paths from `providerOptions.statsFile.paths` and the memory/hardware
helpers' output. The file content is **untrusted input**:

- Values are coerced to finite numbers; a non-number is dropped. Non-canonical keys are reported
  and never folded in.
- There is no size limit on an individual stats file: `readFileSync(path, 'utf8')` loads the
  whole thing, and a 1 GiB JSON file would be read and parsed. This is a plausible local
  denial-of-service if you point `paths` at a file an untrusted process can grow. **Mitigation:
  point `paths` only at files your own integration writes, and have that writer bound its own
  size.** A size cap before parsing would be a welcome hardening contribution.
- **Symbolic links and TOCTOU.** The reader `existsSync` → `statSync` → `readFileSync`, so a
  path swapped between the existence check and the read is followed. If a stats path lives in a
  directory writable by a lower-privileged user, that user can redirect the read to any file the
  harness can read. The parsed content is then constrained to canonical metric names with finite
  numeric values, so the realistic impact is limited to *influencing a health reading* or
  *causing a parse failure*, not arbitrary data exfiltration. Still, **do not place stats paths
  in world-writable directories.**
- **mtime decides freshness**, and mtime is settable by anyone who can write the file. A stale
  file with a forged mtime can keep a dead integration looking alive; `staleAfterMs` is a
  defense against accident, not against an adversary.
- **Trusting the source is your decision.** A forged `ram_used_ratio: 0.99` raises pressure and
  can cause a throttle or a restart *request*; a forged `gpu_temp_c: 40` hides heat. The plugin
  cannot tell a genuine stats file from a forged one, and it does not try.

#### 3. The decision log

`DecisionLog` writes to `<directory>/decisions.jsonl` with `appendFileSync`, creating the
directory with `mkdirSync(..., { recursive: true })` if needed, and rotating by
`renameSync` + `writeFileSync('')` once the file exceeds `storage.maxLogBytes`.

- **The directory comes from configuration** (`storage.directory`) or from the environment's
  `stateDirectory`. If `DSH_HOME` is writable by another user, that user can replace
  `decisions.jsonl` with a symlink and have this plugin's synchronous write follow it —
  an arbitrary-file **append** primitive limited to content the plugin generates. Do not put the
  plugin's state directory somewhere another principal can write.
- **Log contents are not secret but are not nothing.** Each line contains the action, state,
  pressure, coverage, driver details (metric values, e.g. memory totals) and reason strings. It
  does not contain prompts, transcripts, file contents or credentials.
- **Rotation keeps one `.bak`.** A rotation loop cannot grow without bound; the on-disk footprint
  is roughly `2 × maxLogBytes`. It also cannot be used to delete arbitrary files: the renamed
  path is always the configured log path plus an ISO timestamp.
- **A full or read-only disk degrades rather than fails.** Write errors are counted in
  `writeFailures` and exposed through `lastError`; monitoring continues. That is the right
  trade-off for a health monitor, but it does mean a silent loss of audit trail is possible if
  nobody watches `lastError`.
- **`storage.enabled: false`** makes the plugin strictly memory-only. Use it on a machine where
  you do not want this plugin writing anything at all.

#### 4. Tool output and the model

The three tools are read-only, but their output goes into a session transcript and may be sent
to a model provider. That output includes the hostname indirectly (provider notes can embed
paths and error messages), metric values, provider error strings, and whatever the configured
helper or stats file contains.

- A helper that prints sensitive material on stdout puts it into the sample `note` only if it
  prints it on a malformed line; recognized `name=value` lines are parsed as metrics. Do not use
  a helper that echoes secrets.
- **Tool output is data, not instructions.** Nothing in this plugin interprets text from a stats
  file, a probe, a safe-point source or an adapter response as a command. Reason strings and
  driver details are assembled from metric names and numbers. `note` fields from a provider are
  passed through verbatim into warnings, so a hostile integration could put misleading prose in
  front of a model — treat provider notes as untrusted text if you consume them.
- Tool input is validated: `health_history` rejects a non-canonical metric name with an error
  listing the valid names, and the other two tools accept a small closed enum.

#### 5. Provider and adapter failure as a denial of service

- A provider that throws repeatedly is backed off exponentially up to `providerBackoffMaxMs`.
  Before `providerFailureLimit` is reached there is **no** delay, so a provider that fails
  instantly on every tick costs one rejected promise per tick. That is bounded and cheap.
- A provider whose `sample()` never settles **delays the whole sampling round**, because
  `sampleAll` awaits `Promise.all`. There is no per-provider timeout at the registry level. A
  hung provider is the most effective way to stall this plugin's tick loop, and the health
  monitor going quiet is itself a failure mode. Nothing else in the harness is affected — the
  tick is the plugin's own timer — but if you integrate a telemetry source that can hang, give
  it its own timeout. **A per-provider sampling timeout would be a welcome contribution.**
- `SafePointRegistry.readiness` **does** have a per-source timeout (1 second by default), so a
  hanging safe-point source cannot stall the tick.
- A configured helper command is bounded by `helperTimeoutMs`; `providerOptions.statsFile.commands`
  entries are run with a hard-coded 5-second timeout and ignore their own `timeoutMs`.

#### 6. Configuration as a trust boundary

The configuration document is **trusted input**, read from the profile's patch layer, the
plugin's settings namespace, or a direct library call. It can:

- name an arbitrary executable to run (`helperCommand`, `statsFile.commands[].argv`),
- name arbitrary paths to read (`statsFile.paths`, `runtime.heartbeatFile`) and to write into
  (`storage.directory`),
- raise or lower every threshold and disable every check.

There is no attempt to sanitize any of that, and there should not be: whoever can change the
profile's configuration already has code execution in your harness through any number of other
plugin settings. What the plugin **does** do is refuse to act on a document it cannot validate
(`ConfigError`), so a partially-applied or malformed security-relevant document is rejected
rather than half-honored.

### Explicit non-goals

- **Sandboxing the helper command.** It runs with your privileges, by design. Use OS-level
  controls if you need more.
- **Verifying a stats file's provenance.** There is no signature, no ownership check, no
  authentication.
- **Confidentiality of collected metrics on disk.** The decision log is plaintext.
- **Protecting against a malicious plugin in the same profile.** Every plugin in a profile runs
  in the same process with the same rights.
- **Defending against a compromised harness or a compromised machine.** At that point this
  plugin's readings are not your problem.
- **Network security.** The plugin opens no sockets and has no remote surface to attack.

## Hardening checklist

For a deployment where this plugin's readings matter:

1. Keep the plugin's configuration and the scripts its helper commands point at in a directory
   only you can write.
2. Use absolute paths in `helperCommand` and `statsFile.commands[].argv`; do not rely on `PATH`.
3. Point `statsFile.paths` only at files your own integration writes, and bound their size in
   the writer.
4. Set `storage.directory` to a path under your own control, or set `storage.enabled: false` if
   you do not want this plugin writing anything.
5. Do not enable `maintenance.allowAppRestart` or install `dsh-restart` unless you actually want
   restart requests to be possible. Without both, the highest reachable outcome is
   `PAUSE_NEW_WORK`.
6. Leave `maintenance.urgentOverridePressure` at a value you are comfortable with; it is the one
   setting that lets pressure bypass the maintenance window.
7. Review the `health_status` output periodically. `coverage`, `unknownDimensions`, the provider
   lines and the `warnings` array are where a silently-broken telemetry source shows up. A
   metrics source that has quietly stopped reporting looks exactly like a healthy machine
   except for its coverage.

## Dependencies

`dsh-health-scheduler` has **no runtime dependencies** (`"dependencies": {}` in `package.json`).
Its peer dependencies are `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools` and the optional
`@deepseek-ai/dsh-settings`, all supplied by the harness. Development dependencies are
`typescript` and `@types/node`.

That is worth stating as a security property rather than a packaging detail: there is no
third-party supply chain inside this plugin beyond the TypeScript compiler, and nothing in
`node_modules` is loaded at runtime by the published `lib/`.

## Scope

In scope:

- any way to make this plugin execute something it was not configured to execute,
- any way to make it restart, kill or otherwise act on the system beyond the four action levels,
- any way to make a missing or failed measurement read as healthy,
- any way to make it read or write a file outside the paths it was configured with,
- a crash, unbounded memory growth or unbounded loop reachable from a configuration document, a
  stats file, a provider, an adapter or a safe-point source,
- any unbounded resource use that degrades the harness process.

Out of scope:

- the fact that a configured helper command runs with your privileges,
- fabricated data in a stats file that you chose to point the plugin at,
- the absence of a signature on the decision log,
- the fact that plugin configuration can disable checks,
- vulnerabilities in the harness, in `dsh-restart`, in the supervisor, or in whatever writes
  your stats files,
- anything requiring an attacker who already has your privileges or write access to your
  profile directory.

## License

MIT. See [LICENSE](LICENSE).
