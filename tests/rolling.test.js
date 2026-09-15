/**
 * Rolling-window statistics and trend detection.
 *
 * The behavior under test is the difference between a spike and a trend: a short
 * burst must not look like a leak, and a slow climb must be visible over hours
 * without keeping hours of raw samples.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveConfig } from '../lib/core/config.js'
import { RollingStore } from '../lib/core/rolling.js'
import { TrendAnalyzer, formatBytes, formatSlopePerHour } from '../lib/core/trend.js'

const MINUTE = 60_000
const HOUR = 3_600_000

function store(overrides = {}) {
  const config = resolveConfig(overrides)
  return { config, store: new RollingStore(config.windows) }
}

describe('RollingStore', () => {
  it('computes mean, percentiles and extremes over a window', () => {
    const { store: rolling } = store()
    const base = 1_000_000
    for (let i = 0; i < 100; i += 1) {
      rolling.record('gpu_temp_c', 60 + i * 0.2, base + i * 1000)
    }
    const stats = rolling.stats('gpu_temp_c', 5 * MINUTE, base + 100 * 1000)
    assert.equal(stats.count, 100)
    assert.equal(stats.min, 60)
    assert.equal(stats.max, 79.8)
    assert.ok(Math.abs(stats.mean - 69.9) < 0.01)
    assert.ok(stats.p95 >= 78, `p95 was ${stats.p95}`)
    assert.equal(stats.latest, 79.8)
    assert.equal(stats.earliest, 60)
  })

  it('returns null statistics for a metric with no data instead of zero', () => {
    const { store: rolling } = store()
    const stats = rolling.stats('gpu_temp_c', 5 * MINUTE, 1_000_000)
    assert.equal(stats.count, 0)
    assert.equal(stats.mean, null)
    assert.equal(stats.p95, null)
    assert.equal(stats.slopePerHour, null)
    assert.equal(stats.latest, null)
  })

  it('raises the raw floor to the longest statistics window when the floor is shorter', () => {
    const { config, store: rolling } = store({ windows: { rawMs: 5 * MINUTE, windowsMs: [5 * MINUTE, 30 * MINUTE] } })
    // 5 minutes of floor cannot back a 30 minute window, so the floor is raised.
    assert.equal(config.windows.rawMs, 30 * MINUTE)
    const base = 10_000_000
    for (let i = 0; i < 500; i += 1) rolling.record('cpu_usage', 0.5, base + i * MINUTE)
    const kept = rolling.rawPoints('cpu_usage', 24 * HOUR, base + 500 * MINUTE)
    assert.equal(kept.length, 31)
    assert.equal((kept[0]?.t ?? 0) - base, 469 * MINUTE)
  })

  it('honours an explicitly longer raw floor than the longest window', () => {
    const { config, store: rolling } = store({
      windows: { rawMs: 12 * HOUR, windowsMs: [5 * MINUTE, 30 * MINUTE] },
    })
    assert.equal(config.windows.rawMs, 12 * HOUR)
    const base = 1_000_000
    for (let i = 0; i < 700; i += 1) rolling.record('cpu_usage', 0.5, base + i * MINUTE)
    const kept = rolling.rawPoints('cpu_usage', 24 * HOUR, base + 700 * MINUTE)
    // 700 minutes fit inside a 12 hour floor, so nothing is dropped.
    assert.equal(kept.length, 700)
    assert.equal(kept[0]?.t, base)
  })

  it('keeps aggregate buckets far beyond the raw horizon', () => {
    const { store: rolling } = store()
    const base = 100_000_000
    for (let i = 0; i < 24 * 12; i += 1) {
      rolling.record('process_rss_bytes', 1_000_000_000 + i * 10_000_000, base + i * 5 * MINUTE)
    }
    const buckets = rolling.buckets('process_rss_bytes')
    assert.ok(buckets.length >= 200, `expected long-horizon buckets, saw ${buckets.length}`)
    assert.ok(buckets[0].startMs < base + 12 * HOUR)
  })

  it('tracks consecutive time inside a declared band and resets on band change', () => {
    const { store: rolling } = store()
    const base = 1_000_000
    assert.equal(rolling.declareBand('gpu_temp_c', 'gpu_temp_c:warn', base), 0)
    assert.equal(rolling.declareBand('gpu_temp_c', 'gpu_temp_c:warn', base + 30_000), 30_000)
    assert.equal(rolling.declareBand('gpu_temp_c', 'gpu_temp_c:critical', base + 45_000), 0)
    assert.equal(rolling.declareBand('gpu_temp_c', null, base + 50_000), 0)
    assert.equal(rolling.declareBand('gpu_temp_c', 'gpu_temp_c:warn', base + 90_000), 0)
  })

  it('reports statistics for every configured window', () => {
    const { config, store: rolling } = store()
    const base = 50_000_000
    for (let i = 0; i < 400; i += 1) rolling.record('ram_used_ratio', 0.5 + i * 0.0005, base + i * 30_000)
    const perWindow = rolling.statsByWindow('ram_used_ratio', base + 400 * 30_000)
    assert.equal(perWindow.length, config.windows.windowsMs.length)
    for (let i = 1; i < perWindow.length; i += 1) {
      assert.ok(perWindow[i].count >= perWindow[i - 1].count, 'longer windows must not have fewer samples')
    }
  })

  it('bounds memory: raw points stay proportional to the retention horizon, not to uptime', () => {
    const { store: rolling } = store({ windows: { windowsMs: [5 * MINUTE, 30 * MINUTE] } })
    const base = 1_000_000
    for (let i = 0; i < 20_000; i += 1) rolling.record('cpu_usage', 0.3, base + i * 1000)
    // 20 000 seconds (5.5 h) recorded at 1 Hz against a 30 minute horizon.
    assert.ok(rolling.size() <= 1850, `raw store grew to ${rolling.size()} points`)
    assert.ok(rolling.size() >= 1750)
  })
})

describe('daily summaries', () => {
  it('rolls aggregate buckets up per local day, weighted by sample count', () => {
    // Aggregate retention has to reach back over both days for this test, so the
    // retention is stated rather than inherited from the default 24 h.
    const { store: rolling } = store({ windows: { aggregateRetentionMs: 7 * 24 * HOUR } })
    const day1 = new Date(2026, 2, 1, 10, 0, 0, 0).getTime()
    const day2 = day1 + 24 * HOUR

    // Day 1: an hour of 0.5 at 1 Hz, so 60 buckets of 60 samples each.
    for (let i = 0; i < 60; i += 1) {
      for (let j = 0; j < 60; j += 1) rolling.record('cpu_usage', 0.5, day1 + i * MINUTE + j * 1000)
    }
    // Day 2: a short burst of 0.9.
    for (let j = 0; j < 60; j += 1) rolling.record('cpu_usage', 0.9, day2 + j * 1000)

    const days = rolling.dailySummaries(day2 + HOUR)
    assert.equal(days.length, 2)
    const [first, second] = days
    assert.equal(new Date(first.dayStart).getDate(), 1)
    const firstCpu = first.metrics.find((metric) => metric.metric === 'cpu_usage')
    assert.equal(firstCpu.count, 3600)
    assert.ok(Math.abs(firstCpu.mean - 0.5) < 0.001)
    assert.equal(firstCpu.max, 0.5)

    const secondCpu = second.metrics.find((metric) => metric.metric === 'cpu_usage')
    assert.equal(secondCpu.count, 60)
    assert.ok(Math.abs(secondCpu.mean - 0.9) < 0.001)
  })

  it('drops days past the daily retention horizon', () => {
    const { store: rolling } = store({
      windows: { dailyRetentionMs: 2 * 24 * HOUR, aggregateRetentionMs: 30 * 24 * HOUR },
    })
    const ancient = new Date(2026, 2, 1, 12, 0, 0, 0).getTime()
    rolling.record('cpu_usage', 0.5, ancient)
    const recent = ancient + 10 * 24 * HOUR
    rolling.record('cpu_usage', 0.6, recent)
    const days = rolling.dailySummaries(recent)
    assert.equal(days.length, 1)
    assert.equal(new Date(days[0].dayStart).getDate(), new Date(recent).getDate())
  })

  it('sorts metrics by name inside a day', () => {
    const { store: rolling } = store()
    const at = new Date(2026, 2, 1, 9, 0, 0, 0).getTime()
    rolling.record('gpu_temp_c', 60, at)
    rolling.record('cpu_temp_c', 55, at)
    rolling.record('cpu_usage', 0.2, at)
    const [day] = rolling.dailySummaries(at + MINUTE)
    assert.deepEqual(
      day.metrics.map((metric) => metric.metric),
      ['cpu_temp_c', 'cpu_usage', 'gpu_temp_c'],
    )
  })
})

describe('TrendAnalyzer', () => {  it('detects a memory leak as a worsening trend', () => {
    const { config, store: rolling } = store()
    const trends = new TrendAnalyzer(rolling, config.trend)
    const base = 1_000_000
    // 4 hours of a clean +200 MB/h leak on a 2 GB baseline.
    for (let i = 0; i <= 240; i += 1) {
      rolling.record('process_rss_bytes', 2_000_000_000 + i * MINUTE * (200_000_000 / HOUR), base + i * MINUTE)
    }
    const trend = trends.evaluate('process_rss_bytes', base + 240 * MINUTE, 6 * HOUR)
    assert.equal(trend.direction, 'rising')
    assert.equal(trend.isWorsening, true)
    assert.ok(trend.rSquared > 0.99, `R² was ${trend.rSquared}`)
    assert.ok(Math.abs(trend.slopePerHour - 200_000_000) < 5_000_000, `slope was ${trend.slopePerHour}`)
    assert.match(trend.summary, /\/h/)
  })

  it('does not call a rising temperature a problem when the fit is noise', () => {
    const { config, store: rolling } = store()
    const trends = new TrendAnalyzer(rolling, config.trend)
    const base = 1_000_000
    const noisy = [70, 88, 71, 69, 90, 70, 72, 68, 89, 71, 70, 73, 69, 91, 70]
    noisy.forEach((value, index) => rolling.record('gpu_temp_c', value, base + index * MINUTE))
    const trend = trends.evaluate('gpu_temp_c', base + noisy.length * MINUTE, 6 * HOUR)
    assert.equal(trend.isWorsening, false)
    assert.ok(trend.rSquared < 0.5)
  })

  it('does not treat a falling temperature as worsening', () => {
    const { config, store: rolling } = store()
    const trends = new TrendAnalyzer(rolling, config.trend)
    const base = 1_000_000
    for (let i = 0; i < 60; i += 1) rolling.record('gpu_temp_c', 90 - i * 0.5, base + i * MINUTE)
    const trend = trends.evaluate('gpu_temp_c', base + 60 * MINUTE, 6 * HOUR)
    assert.equal(trend.direction, 'falling')
    assert.equal(trend.isWorsening, false)
  })

  it('treats a falling recovery_rate as worsening', () => {
    const { config, store: rolling } = store()
    const trends = new TrendAnalyzer(rolling, config.trend)
    const base = 1_000_000
    for (let i = 0; i < 60; i += 1) rolling.record('recovery_rate', 0.9 - i * 0.008, base + i * MINUTE)
    const trend = trends.evaluate('recovery_rate', base + 60 * MINUTE, 6 * HOUR)
    assert.equal(trend.direction, 'falling')
    assert.equal(trend.isWorsening, true)
  })

  it('refuses to report a slope before the minimum observation span', () => {
    const { config, store: rolling } = store()
    const trends = new TrendAnalyzer(rolling, config.trend)
    const base = 1_000_000
    for (let i = 0; i < 5; i += 1) rolling.record('process_rss_bytes', 1e9 + i * 1e7, base + i * 1000)
    const trend = trends.evaluate('process_rss_bytes', base + 5000, 6 * HOUR)
    assert.equal(trend.direction, 'unknown')
    assert.equal(trend.slopePerHour, null)
    assert.match(trend.summary, /insufficient observation/)
  })

  it('projects when a leak reaches a ceiling', () => {
    const { config, store: rolling } = store()
    const trends = new TrendAnalyzer(rolling, config.trend)
    const base = 1_000_000
    for (let i = 0; i <= 180; i += 1) {
      rolling.record('process_rss_bytes', 4_000_000_000 + i * MINUTE * (500_000_000 / HOUR), base + i * MINUTE)
    }
    const projection = trends.projectToCeiling('process_rss_bytes', 8_000_000_000, base + 180 * MINUTE, 6 * HOUR)
    assert.ok(projection.perHour > 450_000_000, `slope was ${projection.perHour}`)
    // The latest sample sits 2.5 GB under the ceiling at 500 MB/h, i.e. 5 h.
    assert.ok(projection.msToCeiling > 2 * HOUR, `projected ${projection.msToCeiling}`)
    assert.ok(projection.msToCeiling <= 5 * HOUR, `projected ${projection.msToCeiling}`)
  })

  it('formats slopes in the metric own unit', () => {
    assert.equal(formatBytes(1_500_000_000), '1.40 GB')
    assert.equal(formatBytes(2_500_000), '2.4 MB')
    assert.equal(formatSlopePerHour('process_rss_bytes', 400_000_000), '381.5 MB/h')
    assert.equal(formatSlopePerHour('gpu_temp_c', 12), '12.00 °C/h')
  })

  it('returns only worsening trends, worst fit first', () => {
    const { config, store: rolling } = store()
    const trends = new TrendAnalyzer(rolling, config.trend)
    const base = 1_000_000
    for (let i = 0; i <= 120; i += 1) {
      rolling.record('process_rss_bytes', 1e9 + i * MINUTE * 3e8 / HOUR, base + i * MINUTE)
      rolling.record('cpu_temp_c', 60, base + i * MINUTE)
    }
    const worsening = trends.worsening({}, base + 120 * MINUTE, 6 * HOUR)
    assert.deepEqual(
      worsening.map((trend) => trend.metric),
      ['process_rss_bytes'],
    )
  })
})
