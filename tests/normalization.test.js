/**
 * Normalization, band arithmetic and hysteresis-free scoring.
 *
 * These are the rules that decide what counts as a measurement at all, so they
 * are tested first: a number that is not physical, a ratio sent as a percentage,
 * and 鈥?the important one 鈥?a metric that simply was not measured.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeSample, parseSampleTime } from '../lib/core/normalize.js'
import { LEVEL_BOUNDS, clamp, levelOf, rampEndpoints, scoreMetric, scoreWithSustain } from '../lib/core/bands.js'
import { CANONICAL_METRICS, METRICS, isCanonicalMetric, metricDescriptor } from '../lib/types/metrics.js'

describe('canonical metric registry', () => {
  it('exposes a descriptor for every metric name', () => {
    assert.ok(CANONICAL_METRICS.length >= 40, 'the vocabulary should cover every designed subsystem')
    for (const name of CANONICAL_METRICS) {
      const descriptor = metricDescriptor(name)
      assert.ok(descriptor, `${name} must have a descriptor`)
      assert.equal(descriptor.name, name)
      assert.ok(descriptor.description.length > 0)
    }
  })

  it('keeps the registry keys sorted and unique', () => {
    const sorted = [...CANONICAL_METRICS].sort()
    assert.deepEqual(CANONICAL_METRICS, sorted)
    assert.equal(new Set(CANONICAL_METRICS).size, CANONICAL_METRICS.length)
  })

  it('rejects names outside the vocabulary', () => {
    assert.equal(isCanonicalMetric('gpu_temp_c'), true)
    assert.equal(isCanonicalMetric('gpu_temp'), false)
    assert.equal(isCanonicalMetric('__proto__'), false)
    assert.equal(isCanonicalMetric('toString'), false)
  })

  it('declares hard bounds only where physics justifies them', () => {
    assert.equal(METRICS.cpu_temp_c.hardMax, 130)
    assert.equal(METRICS.ram_used_ratio.hardMax, 1)
    assert.equal(METRICS.process_rss_bytes.hardMax, undefined)
    assert.equal(METRICS.recovery_rate.polarity, 'lower-is-worse')
    assert.equal(METRICS.ram_available_bytes.polarity, 'lower-is-worse')
  })
})

describe('normalizeSample', () => {
  const base = { provider: 'test', timestamp: '2026-01-01T00:00:00.000Z' }

  it('keeps measured values and reports nothing', () => {
    const result = normalizeSample({ ...base, metrics: { cpu_temp_c: 71, cpu_usage: 0.42 } })
    assert.deepEqual(result.metrics, { cpu_temp_c: 71, cpu_usage: 0.42 })
    assert.deepEqual(result.violations, [])
  })

  it('omits absent metrics instead of inventing zero', () => {
    const result = normalizeSample({ ...base, metrics: {} })
    assert.deepEqual(result.metrics, {})
    assert.equal('gpu_temp_c' in result.metrics, false)
  })

  it('rejects non-finite and non-numeric readings', () => {
    const result = normalizeSample({
      ...base,
      metrics: { cpu_temp_c: Number.NaN, gpu_temp_c: Number.POSITIVE_INFINITY, cpu_usage: '0.5' },
    })
    assert.deepEqual(result.metrics, {})
    assert.deepEqual(
      result.violations.map((violation) => `${violation.metric}:${violation.reason}`).sort(),
      ['cpu_temp_c:not_finite', 'cpu_usage:not_a_number', 'gpu_temp_c:not_finite'],
    )
  })

  it('rejects values outside the physical range', () => {
    const result = normalizeSample({ ...base, metrics: { cpu_temp_c: 4000, cpu_usage: -1 } })
    assert.deepEqual(result.metrics, {})
    assert.deepEqual(
      result.violations.map((violation) => `${violation.metric}:${violation.reason}`).sort(),
      ['cpu_temp_c:above_hard_max', 'cpu_usage:below_hard_min'],
    )
  })

  it('clamps a percentage sent where a ratio is canonical, and says so', () => {
    const result = normalizeSample({ ...base, metrics: { cpu_usage: 1.2 } })
    assert.equal(result.metrics.cpu_usage, 1)
    assert.equal(result.violations.length, 1)
    assert.equal(result.violations[0].reason, 'clamped')
  })

  it('sorts output by metric name for stable snapshots', () => {
    const result = normalizeSample({ ...base, metrics: { gpu_temp_c: 60, cpu_temp_c: 50, cpu_usage: 0.1 } })
    assert.deepEqual(Object.keys(result.metrics), ['cpu_temp_c', 'cpu_usage', 'gpu_temp_c'])
  })

  it('parses timestamps and rejects nonsense', () => {
    assert.equal(parseSampleTime('2026-01-01T00:00:00.000Z'), Date.parse('2026-01-01T00:00:00.000Z'))
    assert.equal(parseSampleTime('not-a-date'), null)
    assert.equal(parseSampleTime(''), null)
  })
})

describe('band scoring', () => {
  it('scores zero below the warn endpoint and 100 at critical', () => {
    assert.equal(scoreMetric('gpu_temp_c', 70, { warn: 78, critical: 92 }), 0)
    assert.equal(scoreMetric('gpu_temp_c', 78, { warn: 78, critical: 92 }), 0)
    assert.equal(scoreMetric('gpu_temp_c', 92, { warn: 78, critical: 92 }), 100)
    assert.equal(scoreMetric('gpu_temp_c', 99, { warn: 78, critical: 92 }), 100)
  })

  it('ramps linearly in between', () => {
    assert.equal(scoreMetric('gpu_temp_c', 85, { warn: 78, critical: 92 }), 50)
    assert.equal(scoreMetric('gpu_temp_c', 81, { warn: 78, critical: 92 }), 21)
  })

  it('accepts a band written in either order', () => {
    // recovery_rate: 0.8 is healthy, 0.3 is critical.
    assert.equal(scoreMetric('recovery_rate', 0.9, { warn: 0.8, critical: 0.3 }), 0)
    assert.equal(scoreMetric('recovery_rate', 0.3, { warn: 0.8, critical: 0.3 }), 100)
    assert.equal(scoreMetric('recovery_rate', 0.55, { warn: 0.8, critical: 0.3 }), 50)
    assert.equal(scoreMetric('recovery_rate', 0.55, { warn: 0.3, critical: 0.8 }), 50)
    assert.deepEqual(rampEndpoints({ warn: 0.8, critical: 0.3 }, 'lower-is-worse'), [0.8, 0.3])
    assert.deepEqual(rampEndpoints({ warn: 0.8, critical: 0.96 }, 'higher-is-worse'), [0.8, 0.96])
  })

  it('returns unknown, not zero, for a missing value', () => {
    assert.equal(scoreMetric('gpu_temp_c', null, { warn: 78, critical: 92 }), null)
    assert.equal(levelOf(null), 'unknown')
  })

  it('maps scores onto the documented level bands', () => {
    assert.equal(levelOf(0), 'none')
    assert.equal(levelOf(LEVEL_BOUNDS.moderate - 1), 'low')
    assert.equal(levelOf(LEVEL_BOUNDS.moderate), 'moderate')
    assert.equal(levelOf(LEVEL_BOUNDS.high), 'high')
    assert.equal(levelOf(LEVEL_BOUNDS.critical), 'critical')
    assert.equal(levelOf(100), 'critical')
  })

  it('clamps out-of-range values into the range', () => {
    assert.equal(clamp(5, 0, 1), 1)
    assert.equal(clamp(-5, 0, 1), 0)
    assert.equal(clamp(0.5, 0, 1), 0.5)
  })
})

describe('sustain gate', () => {
  const band = { warn: 78, critical: 92 }

  it('scores zero while the condition has not been held long enough', () => {
    const gate = scoreWithSustain('gpu_temp_c', 88, band, 60_000, 5_000)
    assert.equal(gate.score, 0)
    assert.equal(gate.rawScore, 71)
    assert.equal(gate.gated, true)
  })

  it('scores the real value once the condition has been held', () => {
    const gate = scoreWithSustain('gpu_temp_c', 88, band, 60_000, 60_000)
    assert.equal(gate.score, 71)
    assert.equal(gate.gated, false)
  })

  it('does not gate when no sustain time is configured', () => {
    const gate = scoreWithSustain('gpu_temp_c', 88, band, 0, 0)
    assert.equal(gate.score, 71)
  })

  it('stays unknown for a missing value regardless of duration', () => {
    const gate = scoreWithSustain('gpu_temp_c', null, band, 60_000, 600_000)
    assert.equal(gate.score, null)
    assert.equal(gate.rawScore, null)
  })
})

