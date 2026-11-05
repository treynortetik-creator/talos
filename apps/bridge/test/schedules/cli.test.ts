// WP-S1 acceptance: `talos-app schedules`, `schedules adopt` (S3.7) and `schedules notify` (S7.4), against the real Chronos CLI.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEARTBEAT_META_KEY, heartbeatConfigHashOf } from '@talos-app/protocol'
import { runCli } from '../../src/cli.ts'
import { recordPass } from '../../src/heartbeat/tested.ts'
import { startHarness } from '../helpers.ts'
import { ChronosBox, draft, MON_0700_EDT } from './chronos-box.ts'
import { longTimeouts, sleep } from './harness.ts'

longTimeouts()

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f()
})

function cliIO(answers: string[] = []) {
  const out: string[] = []
  const err: string[] = []
  const asked: string[] = []
  return {
    out,
    err,
    asked,
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      prompt: async (q: string) => {
        asked.push(q)
        return answers.shift() ?? 'n'
      },
      sleep: async () => {},
      now: () => Date.now(),
    },
  }
}

/** A Chronos 0.2-style install: hand-written jobs, no approved records, Chronos's own session timers. */
function legacyBox() {
  const box = new ChronosBox(MON_0700_EDT)
  box.handWrite({
    id: 'morning-brief',
    name: 'Morning Brief',
    time: '07:30',
    prompt: 'Brief me.\nLine two.\n',
    in_session: true,
    headless: false,
  })
  box.handWrite({
    id: 'nightly-sync',
    name: 'Nightly Sync',
    time: '22:00',
    prompt: 'Sync the folder.\n',
    in_session: false,
  })
  cleanup.push(() => box.dispose())
  return box
}
const env = (box: ChronosBox, home = '/nonexistent') => ({
  TALOS_APP_HOME: home,
  TALOS_APP_CHRONOS_BIN: box.bin,
  PATH: process.env.PATH,
  HOME: box.home,
})
const snapshot = (box: ChronosBox) =>
  box.api<{
    session_runner: string
    approval_required: boolean
    schedules: Array<{ id: string; today: string; changed_outside: boolean; runner: string }>
  }>(['snapshot'])

describe('talos-app schedules', () => {
  test('lists the jobs and the scheduler health', async () => {
    const box = legacyBox()
    const { out, io } = cliIO()
    expect(await runCli(['schedules'], io, env(box))).toBe(0)
    const text = out.join('\n')
    expect(text).toContain('morning-brief')
    expect(text).toContain('nightly-sync')
    expect(text).toContain('session_runner_conflict')
  })

  test('with nothing installed it says so', async () => {
    const { out, io } = cliIO()
    expect(
      await runCli(['schedules'], io, {
        TALOS_APP_HOME: '/nonexistent',
        PATH: '/nonexistent',
        HOME: '/nonexistent',
        TALOS_APP_CHRONOS_AUTODISCOVER: 'on',
      }),
    ).toBe(0)
    expect(out.join('\n')).toContain('No scheduler is installed')
  })
})

describe('talos-app schedules adopt (S3.7)', () => {
  test('approves one by one (y/N), then switches enforcement on: only the N answers are held', async () => {
    const box = legacyBox()
    const { out, io, asked } = cliIO(['y', 'n'])
    expect(snapshot(box).session_runner).toBe('hook')
    expect(await runCli(['schedules', 'adopt'], io, env(box))).toBe(0)
    expect(asked[0]).toBe('Approve "Morning Brief" as it is on disk now? [y/N] ')
    expect(asked.length).toBe(2)
    const s = snapshot(box)
    expect(s.session_runner).toBe('talos')
    expect(s.approval_required).toBe(true)
    expect(s.schedules.find((j) => j.id === 'morning-brief')?.today).not.toBe('held')
    expect(s.schedules.find((j) => j.id === 'nightly-sync')?.today).toBe('held')
    expect(out.join('\n')).toContain('Restart your Claude session')
    // running it again is safe: nothing already approved is asked about again
    const again = cliIO(['n'])
    expect(await runCli(['schedules', 'adopt'], again.io, env(box))).toBe(0)
    expect(again.asked).toEqual(['Approve "Nightly Sync" as it is on disk now? [y/N] '])
  })

  test('a `both` job: y converts it to session-only (and it is not held); n keeps the switch refused', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    cleanup.push(() => box.dispose())
    box.handWrite({ id: 'both-job', name: 'Both Job', time: '07:30', prompt: 'Do it.\n', in_session: true }) // headless absent = true = both
    expect(snapshot(box).schedules[0]?.runner).toBe('both')
    const no = cliIO(['y', 'n'])
    expect(await runCli(['schedules', 'adopt'], no.io, env(box))).toBe(1)
    expect(snapshot(box).session_runner).toBe('hook') // Chronos stays on its own timers; Talos stays read-only
    const yes = cliIO(['y', 'y'])
    expect(await runCli(['schedules', 'adopt'], yes.io, env(box))).toBe(0)
    const s = snapshot(box)
    expect(s.session_runner).toBe('talos')
    expect(s.schedules[0]?.runner).toBe('session')
    expect(s.schedules[0]?.today).not.toBe('held') // a job adopt converts is never held (N2)
  })

  test('an enabled heartbeat edited outside the app is approved only with a passing test of its settings; without one it stays on hold and the words say why', async () => {
    const beat = {
      schema: 'talos.heartbeat/1',
      mode: 'shadow',
      sources: [{ id: 'gh-main', kind: 'github', enabled: true, args: { repos: ['acme/widgets'] }, timeout_s: 30 }],
      mutes: [],
      wake_cap_per_day: 3,
      run_timeout_s: 120,
    }
    const box = new ChronosBox(MON_0700_EDT)
    cleanup.push(() => box.dispose())
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(
      draft({
        id: 'beat',
        name: 'Beat',
        when: { type: 'times', days: 'weekdays', times: ['09:45', '12:15', '14:45', '17:15'] },
        meta: { [HEARTBEAT_META_KEY]: beat },
      }),
      MON_0700_EDT,
    )
    box.editPromptOutside('beat', 'Something else.\n') // now it is "changed outside": adopt is asked about it
    expect(snapshot(box).schedules.find((j) => j.id === 'beat')?.changed_outside).toBe(true)
    const home = join(box.dir, 'talos-home')
    mkdirSync(home, { recursive: true })
    const no = cliIO(['y'])
    await runCli(['schedules', 'adopt'], no.io, env(box, home))
    expect(no.err.join('\n')).toContain('Run a heartbeat test for these settings first')
    expect(snapshot(box).schedules.find((j) => j.id === 'beat')?.changed_outside).toBe(true) // not approved
    // a passing test of exactly these settings (what the bridge writes after a real test) lets it through
    recordPass(home, heartbeatConfigHashOf(beat), Date.now())
    const yes = cliIO(['y'])
    await runCli(['schedules', 'adopt'], yes.io, env(box, home))
    expect(snapshot(box).schedules.find((j) => j.id === 'beat')?.changed_outside).toBe(false)
  })

  test('adopt writes nothing in $TALOS_APP_HOME', async () => {
    const box = legacyBox()
    const home = join(box.dir, 'talos-home')
    const { io } = cliIO(['n', 'n'])
    await runCli(['schedules', 'adopt'], io, env(box, home))
    const { existsSync } = await import('node:fs')
    expect(existsSync(home)).toBe(false)
  })
})

describe('talos-app schedules notify (S7.4)', () => {
  test('posts to the thread of $CHRONOS_JOB over signed HTTP, with no session; falls back to the default thread', async () => {
    const box = new ChronosBox(MON_0700_EDT)
    box.configure({ sessionRunner: 'talos', approvalRequired: true })
    box.create(draft())
    cleanup.push(() => box.dispose())
    const h = await startHarness({
      startBridge: false,
      env: { TALOS_APP_CHRONOS_BIN: box.bin, PATH: process.env.PATH ?? '' },
    })
    cleanup.push(() => h.stop())
    writeFileSync(
      join(h.home, 'schedules-meta.json'),
      JSON.stringify({
        adapter: 'chronos',
        jobs: { 'daily-digest': { thread_id: 'inbox' } },
        offers: {},
        inflight: {},
        runs: {},
        notified: {},
      }),
    )
    const base = { TALOS_APP_HOME: h.home, TALOS_APP_RELAY_URL: h.relay.httpUrl, PATH: process.env.PATH }
    const a = cliIO()
    expect(
      await runCli(['schedules', 'notify', 'Daily', 'Digest', 'is', 'waiting'], a.io, {
        ...base,
        CHRONOS_JOB: 'daily-digest',
      }),
    ).toBe(0)
    const f = await h.relay.expectFrame('reply', (r) => r.message.text === 'Daily Digest is waiting', {
      direction: 'from_bridge',
    })
    expect(f.message.thread_id).toBe('inbox')
    const b = cliIO()
    expect(await runCli(['schedules', 'notify', 'No', 'job', 'set'], b.io, base)).toBe(0)
    const g = await h.relay.expectFrame('reply', (r) => r.message.text === 'No job set', { direction: 'from_bridge' })
    expect(g.message.thread_id).toBe('general')
    const c = cliIO()
    expect(await runCli(['schedules', 'notify'], c.io, base)).toBe(1)
    void sleep
    void readFileSync
  })
})
