// `schedule_propose` with 12 fire times, the documented maximum, through the REAL Chronos CLI (third_party/chronos). Chronos's
// own when-words for 12 times are longer than a card's preview may carry (120 characters, which every shipped app enforces),
// and the bridge used to refuse the whole answer ("preview.when_text: Too big"). The card now shows the first times and
// "and N more", and stays within the limit an older app reads.
import { afterEach, expect, test } from 'bun:test'
import {
  type CardT,
  PREVIEW_WHEN_MAX,
  SCHEDULES_FEATURE,
  SCHEDULES_FEATURE_V2,
  ScheduleCardPayload,
  shortWhenText,
} from '@talos-app/protocol'
import { longTimeouts, type SchedHarness, startSched } from './harness.ts'

longTimeouts()
let h: SchedHarness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const TWELVE = Array.from({ length: 12 }, (_, i) => `${String(8 + i).padStart(2, '0')}:00`)

test('12 fire times: the proposal goes through and the card says the first times and how many more', async () => {
  h = await startSched({ sessionRunner: 'talos', relay: { relayFeatures: [SCHEDULES_FEATURE, SCHEDULES_FEATURE_V2] } })
  const r = await h.bridge.callTool('schedule_propose', {
    op: 'create',
    thread_id: 'inbox',
    reason: 'The owner asked for hourly check-ins.',
    name: 'Hourly',
    id: 'hourly-12',
    when: { type: 'times', days: 'weekdays', times: TWELVE },
    prompt: 'Check in.\n',
  })
  const text = r.content[0]?.text ?? ''
  expect(r.isError, text).toBeFalsy()
  const id = /card (c_[0-9A-HJKMNP-TV-Z]{26}) pending/.exec(text)?.[1]
  const cc = await h.app.expectFrame('card.create', (c) => c.card.id === id, { direction: 'in' })
  const p = ScheduleCardPayload.parse((cc.card as CardT).payload)
  expect(p.preview.when_text.length).toBeLessThanOrEqual(PREVIEW_WHEN_MAX)
  expect(p.preview.when_text).toStartWith('Weekdays at 8:00 AM, 9:00 AM')
  expect(p.preview.when_text).toMatch(/ and \d+ more$/)
})

test('the shortening: short words stay as written; a long list keeps as many times as fit; other long text ends in …', () => {
  expect(shortWhenText('Weekdays at 7:30 AM')).toBe('Weekdays at 7:30 AM')
  const names = TWELVE.map((t) => `${Number(t.slice(0, 2)) % 12 || 12}:00 ${Number(t.slice(0, 2)) < 12 ? 'AM' : 'PM'}`)
  const long = `Mon, Tue, Wed and Thu at ${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  expect(long.length).toBeGreaterThan(PREVIEW_WHEN_MAX)
  const s = shortWhenText(long)
  expect(s.length).toBeLessThanOrEqual(PREVIEW_WHEN_MAX)
  const kept = Number(/ and (\d+) more$/.exec(s)?.[1])
  expect(s.split(' at ')[1]?.split(', ').length).toBe(12 - kept)
  // one more time would not have fitted: as many as fit, not just the first three
  const one = `Mon, Tue, Wed and Thu at ${names.slice(0, 13 - kept).join(', ')} and ${kept - 1} more`
  expect(one.length).toBeGreaterThan(PREVIEW_WHEN_MAX)
  const other = 'x'.repeat(300)
  expect(shortWhenText(other)).toHaveLength(PREVIEW_WHEN_MAX)
  expect(shortWhenText(other).endsWith('…')).toBe(true)
})
