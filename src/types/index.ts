/**
 * Barrel for the plugin's type vocabulary.
 *
 * The types are split by concern — metrics, providers, windows, decisions,
 * configuration — and re-exported here so internal modules can import from one
 * place without creating cycles between the splits.
 *
 * @module dsh-health-scheduler/types
 */

export * from './metrics.js'
export type { DegradedReason, HealthProvider, HealthSample, ProviderFailure, ProviderGroup, ProviderStatus } from './provider.js'
export * from './window.js'
export * from './decision.js'
export * from './config.js'
