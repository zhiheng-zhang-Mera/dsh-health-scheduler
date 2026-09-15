/**
 * The narrow slice of the harness context this plugin uses.
 *
 * The plugin deliberately does not depend on the harness's full `Context` type:
 * it declares the handful of services it actually touches, so the plugin compiles
 * and runs against any harness release that provides those services, and a
 * missing service is a runtime fact the plugin handles instead of a type error.
 *
 * @module dsh-health-scheduler/dsh/context
 */

/** Minimal logger surface. */
export interface PluginLogger {
  debug?(message: string, ...rest: unknown[]): void
  info(message: string, ...rest: unknown[]): void
  warn(message: string, ...rest: unknown[]): void
  error(message: string, ...rest: unknown[]): void
}

/** One registered settings namespace handle. */
export interface SettingsScopeLike<T> {
  get(): T
  watch?(callback: (next: T, prev: T) => void | Promise<void>): () => void
}

/** Minimal settings service surface. */
export interface SettingsServiceLike {
  register<T>(ns: string, schema: unknown, options?: { base?: Partial<T>; applies?: 'live' | 'restart' }): SettingsScopeLike<T>
}

/** A tool definition, structurally compatible with `defineTool`'s output. */
export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    readonly render: (args: unknown, value: unknown) => readonly unknown[]
  }
  readonly execute: (args: never, exec?: { signal?: AbortSignal }) => Promise<unknown>
  readonly timeoutMs?: number
}

/** Minimal tool runtime surface. */
export interface ToolRuntimeLike {
  register(definition: ToolDefinitionLike): () => void
}

/** Everything the plugin reads off `ctx`. */
export interface HarnessContextLike {
  readonly logger?: PluginLogger
  /** `true` while the plugin is being disposed, so timers can be stopped. */
  readonly disposed?: boolean
  readonly tools?: ToolRuntimeLike
  readonly settings?: SettingsServiceLike
  /**
   * Optional: another plugin may publish an object named `healthScheduler` —
   * typically `dsh-restart`'s adapter — through the harness scope. When present
   * it is used instead of the built-in unavailable adapter.
   */
  readonly healthScheduler?: unknown
  on?(event: string, listener: (...args: unknown[]) => void): () => void
  effect?(callback: () => void | (() => void)): void
}

/** A no-op logger, used when the harness does not provide one. */
export const SILENT_LOGGER: PluginLogger = Object.freeze({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
})

/** Extract a usable logger from the context. */
export function loggerOf(ctx: HarnessContextLike): PluginLogger {
  return ctx.logger ?? SILENT_LOGGER
}
