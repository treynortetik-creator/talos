// HB5b review R1-4: in shadow mode the test sheet says plainly that the heartbeat only records, and never shows the
// "would wake / would post" lists or the "nothing needed you" pass line for a shadow result that found things.
import { HeartbeatConfig, parseHeartbeatTestResult } from '@talos-app/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Result } from '../../src/features/schedules/heartbeat/TestSheet.tsx'

afterEach(cleanup)
const cfg = (mode: 'shadow' | 'live') =>
  HeartbeatConfig.parse({
    schema: 'talos.heartbeat/1',
    mode,
    sources: [{ id: 'news', kind: 'inbox', enabled: true, args: {}, timeout_s: 30 }],
    mutes: [],
  })
const result = (over: Record<string, unknown>) => {
  const p = parseHeartbeatTestResult({
    config_hash: `sha256:${'a'.repeat(64)}`,
    at: '2026-10-28T15:32:10.120Z',
    window_h: 24,
    with_agent: false,
    sources: [{ id: 'news', ok: true, ms: 100, read: 2, act: 1, fyi: 1, dropped: 0, held: 0, unreadable: 0 }],
    would_wake: [],
    would_post: [],
    held: 0,
    est_wakes: 0,
    est_tokens: 0,
    ...over,
  })
  if (!p.ok) throw new Error(p.problem)
  return p.result
}

describe('the test sheet and the mode', () => {
  it('shadow: says it records only, shows what live would do, and does not call a result with findings "nothing needed you"', () => {
    render(
      <Result
        config={cfg('shadow')}
        r={result({
          mode: 'shadow',
          if_live: {
            would_wake: [{ source: 'news', title: 'Needs you', why: 'x' }],
            would_post: [],
            est_wakes: 1,
            est_tokens: 180000,
          },
        })}
      />,
    )
    expect(screen.getByText('Shadow: records only, never wakes or posts')).toBeTruthy()
    expect(screen.getByText(/If live: would wake the agent for 1/)).toBeTruthy()
    expect(screen.queryByTestId('test-empty')).toBeNull()
    expect(screen.queryByText(/Would wake the agent for/)).toBeNull()
  })
  it('live: no shadow line, and the wake list is the real one', () => {
    render(
      <Result
        config={cfg('live')}
        r={result({
          mode: 'live',
          would_wake: [{ source: 'news', title: 'Needs you', why: 'x' }],
          est_wakes: 1,
          est_tokens: 180000,
        })}
      />,
    )
    expect(screen.queryByText(/Shadow: records only/)).toBeNull()
    expect(screen.getByText(/Would wake the agent for 1/)).toBeTruthy()
  })
  it('an older Mac that sends no mode: the sheet falls back to the config it asked about', () => {
    render(<Result config={cfg('shadow')} r={result({})} />)
    expect(screen.getByText('Shadow: records only, never wakes or posts')).toBeTruthy()
  })
  it('a result that says the run broke shows the reason', () => {
    render(<Result config={cfg('live')} r={result({ error: 'The test could not finish. Try again.' })} />)
    expect(screen.getByText(/could not finish/)).toBeTruthy()
  })
})
