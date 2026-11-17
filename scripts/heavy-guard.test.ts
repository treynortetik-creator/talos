// scripts/heavy-guard.sh: the load and memory guard heavy-lock.sh asks before a heavy job starts. It is off until a machine
// turns it on, each check is off until its own setting exists, it only lists and refuses (never stops anything), and a probe,
// file or setting it can't read never makes it say "not now".
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const HG = join(here, 'heavy-guard.sh')
const HL = join(here, 'heavy-lock.sh')
// macOS's own bash 3.2 where there is one, so a newer-bash-only construct goes red here
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'
vi.setConfig({ testTimeout: 60_000 })
const dirs: string[] = []
const kids: ChildProcess[] = []
afterEach(() => {
  const live = kids.splice(0).filter((k) => k.pid && k.exitCode === null && k.signalCode === null)
  for (const k of live) spawnSync('kill', ['-TERM', String(k.pid)])
  if (live.length) spawnSync('sleep', ['1'])
  for (const k of live) if (k.exitCode === null && k.signalCode === null) spawnSync('kill', ['-KILL', String(k.pid)])
})
afterAll(() => {
  for (const d of dirs.splice(0)) {
    spawnSync('chmod', ['-R', 'u+rwx', d])
    rmSync(d, { recursive: true, force: true })
  }
})
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'hguard-'))
  dirs.push(d)
  return d
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// 2026-11-12 12:00 UTC; every test runs in UTC so HH:MM means the same everywhere
const NOW = Date.UTC(2026, 10, 12, 12, 0) / 1000
const at = (iso: string) => Date.parse(`${iso}Z`) / 1000

function machine() {
  const cache = tmp()
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: cache,
    TZ: 'UTC',
    TALOS_CI_CACHE: cache,
    TALOS_HEAVY_SLOTS: '1', // the lock as it was; the test below that is about the slots says 3
    TALOS_CI_SLOTS: '1', // CI has slot 1 alone, as the tests here were written
    HEAVY_GUARD_TEST: '1', // the probe overrides below count only with this
    HEAVY_LOCK_POLL: '0.1',
    TALOS_HEAVY_GUARD: join(cache, 'no-guard'),
  }
  const gdir = join(cache, 'guard')
  const g = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(BASH, [HG, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 30_000 })
  const first = (r: ReturnType<typeof g>) => r.stdout.split('\n')[0]
  const conf = (body: string) => {
    mkdirSync(gdir, { recursive: true })
    writeFileSync(join(gdir, 'guard.env'), body)
  }
  // a bookings file, stamped as `book` stamps it: with the clock of its write (the test clock unless told otherwise)
  const bookings = (lines: string, stamp = NOW - 60) => {
    mkdirSync(gdir, { recursive: true })
    const f = join(gdir, 'bookings.tsv')
    writeFileSync(f, lines)
    utimesSync(f, stamp, stamp)
  }
  const read = () => readFileSync(join(gdir, 'bookings.tsv'), 'utf8')
  const until = async (f: () => boolean, ms = 20_000) => {
    const end = Date.now() + ms
    while (!f()) {
      if (Date.now() > end) throw new Error('timed out')
      await sleep(50)
    }
  }
  return { cache, env, gdir, g, first, conf, bookings, read, until }
}
// healthy probes: lots of memory free, a quiet machine
const calm = { HEAVY_GUARD_FREE_PCT: '90', HEAVY_GUARD_MEM_GB: '32', HEAVY_GUARD_LOAD1: '1.5', HEAVY_GUARD_CORES: '10' }

describe('heavy-guard.sh check (the hook): each check, its go and its not-now line', () => {
  it('off by default: no guard.env and no settings answers go without running a single probe', () => {
    const m = machine()
    // stand-in probes that write down that they ran
    const bin = join(m.cache, 'bin')
    mkdirSync(bin)
    for (const t of ['memory_pressure', 'sysctl', 'uptime', 'nproc', 'getconf', 'date'])
      writeFileSync(join(bin, t), `#!/bin/sh\necho ran >> "${m.cache}/probed"\necho 1\n`, { mode: 0o755 })
    for (const args of [['gate'], ['check', 'gate']]) {
      const r = m.g(args, { PATH: `${bin}:${m.env.PATH}`, HEAVY_GUARD_FREE_PCT: '1', HEAVY_GUARD_LOAD1: '999' })
      expect(r.status).toBe(0)
      expect(m.first(r)).toBe('go: guard off on this machine (no guard.env)')
    }
    expect(existsSync(join(m.cache, 'probed'))).toBe(false)
    expect(m.g(['status'], { HEAVY_GUARD_TEST: '' }).stdout.split('\n')[0]).toBe(
      'guard: off on this machine (no guard.env)',
    )
  })

  it('memory floor: below it is not now, with the numbers; at or above it is go', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\n')
    const r = m.g(['gate'], { ...calm, HEAVY_GUARD_FREE_PCT: '31' })
    expect(r.status).toBe(75)
    expect(m.first(r)).toBe('not now: memory is tight (31% free, needs 40%)')
    expect(m.g(['check', 'gate'], { ...calm, HEAVY_GUARD_FREE_PCT: '40' }).status).toBe(0)
  })

  it('load limit: off unless set (no default from the cores); above it is not now', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\n')
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_LOAD1: '140' }).status).toBe(0) // a CI box at load 140: no limit set
    const r = m.g(['gate'], { ...calm, HEAVY_GUARD_MAX_LOAD: '12', HEAVY_GUARD_LOAD1: '14.2' })
    expect(r.status).toBe(75)
    expect(m.first(r)).toBe('not now: load is 14.2 on 10 cores (limit 12)')
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_MAX_LOAD: '12', HEAVY_GUARD_LOAD1: '12' }).status).toBe(0)
  })

  it('a booked window: someone else\u2019s blocks with who, until and the note; the booker\u2019s own job runs', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    m.bookings(`${at('2026-11-12T11:00')}\t${at('2026-11-12T15:00')}\tmodel-owner\tlocal model eval\n`)
    const r = m.g(['gate'], { ...calm, HEAVY_GUARD_NOW: String(NOW) })
    expect(r.status).toBe(75)
    expect(m.first(r)).toBe('not now: booked for model-owner until 15:00 (local model eval)')
    expect(m.g(['model-owner'], { ...calm, HEAVY_GUARD_NOW: String(NOW) }).status).toBe(0)
    // before and after the window: go
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-12T10:59')) }).status).toBe(0)
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-12T15:00')) }).status).toBe(0)
  })

  it('order: booking, then memory, then load; the first failing check answers', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\nHEAVY_GUARD_MAX_LOAD=12\nHEAVY_GUARD_BOOKINGS=1\n')
    m.bookings(`${at('2026-11-12T11:00')}\t${at('2026-11-12T15:00')}\tother\t\n`)
    const bad = { ...calm, HEAVY_GUARD_NOW: String(NOW), HEAVY_GUARD_FREE_PCT: '10', HEAVY_GUARD_LOAD1: '50' }
    expect(m.first(m.g(['gate'], bad))).toBe('not now: booked for other until 15:00')
    expect(m.first(m.g(['other'], bad))).toBe('not now: memory is tight (10% free, needs 40%)')
    expect(m.first(m.g(['other'], { ...bad, HEAVY_GUARD_FREE_PCT: '90' }))).toBe(
      'not now: load is 50 on 10 cores (limit 12)',
    )
  })

  it('a probe that fails, or reads something that is not a number, skips its check', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\nHEAVY_GUARD_MAX_LOAD=12\nHEAVY_GUARD_BOOKINGS=1\n')
    m.bookings(`${at('2026-11-12T11:00')}\t${at('2026-11-12T15:00')}\tother\t\n`)
    for (const bad of ['', 'abc', '-5', '1.2.3', '12%', '1e9', ' 3']) {
      const r = m.g(['gate'], { HEAVY_GUARD_FREE_PCT: bad, HEAVY_GUARD_LOAD1: bad, HEAVY_GUARD_NOW: bad })
      expect(r.status, `${bad}: ${r.stdout}`).toBe(0)
    }
    // a free percentage over 100 is not understood either
    expect(m.g(['gate'], { HEAVY_GUARD_FREE_PCT: '101', HEAVY_GUARD_LOAD1: 'x', HEAVY_GUARD_NOW: 'x' }).status).toBe(0)
    // the load probe failing still lets the memory check answer
    const r = m.g(['gate'], { HEAVY_GUARD_FREE_PCT: '5', HEAVY_GUARD_LOAD1: 'x', HEAVY_GUARD_NOW: 'x' })
    expect(m.first(r)).toBe('not now: memory is tight (5% free, needs 40%)')
  })

  it('HEAVY_GUARD_OFF=1 answers go with "guard off", for check and ask', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\nHEAVY_GUARD_OFF=1\n')
    const r = m.g(['gate'], { HEAVY_GUARD_FREE_PCT: '1' })
    expect([r.status, m.first(r)]).toEqual([0, 'guard off'])
    const a = m.g(['ask', '4'], { HEAVY_GUARD_FREE_PCT: '1', HEAVY_GUARD_MEM_GB: '32' })
    expect([a.status, m.first(a)]).toEqual([0, 'guard off'])
    expect(m.g(['status']).stdout.split('\n')[1]).toBe('guard: off (HEAVY_GUARD_OFF=1)')
  })

  it('the environment turns a check on without guard.env, and wins over guard.env', () => {
    const m = machine()
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_MIN_FREE_PCT: '95' }).status).toBe(75)
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=95\n')
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_MIN_FREE_PCT: '50' }).status).toBe(0)
  })
})

describe('the lock\u2019s own work is never refused for the load it causes', () => {
  // a holder of the heavy lock, through heavy-lock.sh itself; it waits for <cache>/go
  const holder = (m: ReturnType<typeof machine>) => {
    const c = spawn(
      BASH,
      [
        HL,
        'run',
        'holder',
        '--',
        'sh',
        '-c',
        `: > "${m.cache}/held"; while [ ! -f "${m.cache}/go" ]; do sleep 0.05; done`,
      ],
      { env: m.env },
    )
    kids.push(c)
    return { c, done: new Promise((r) => c.on('exit', r)) }
  }

  it('while the heavy lock is held, a job is not refused for load; memory still applies; ask still checks load', async () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\nHEAVY_GUARD_MAX_LOAD=4\n')
    const hot = { ...calm, HEAVY_GUARD_LOAD1: '30' }
    expect(m.g(['gate'], hot).status).toBe(75) // idle lock: a new job may not start on a hot machine
    const h = holder(m)
    await m.until(() => existsSync(join(m.cache, 'held')))
    expect(m.g(['gate'], hot).status).toBe(0)
    expect(m.first(m.g(['gate'], { ...hot, HEAVY_GUARD_FREE_PCT: '10' }))).toBe(
      'not now: memory is tight (10% free, needs 40%)',
    )
    expect(m.first(m.g(['ask', '1'], hot))).toBe('not now: load is 30 on 10 cores (limit 4)')
    writeFileSync(join(m.cache, 'go'), '')
    await h.done
    // just released: the load is still that job's, so the next step of the same run is not held back
    expect(m.g(['gate'], hot).status).toBe(0)
    // the lock idle for longer than the settle time: a new job may not start on a hot machine
    const old = Date.now() / 1000 - 400
    utimesSync(join(m.cache, 'locks'), old, old)
    expect(m.g(['gate'], hot).status).toBe(75)
  })

  it('the gap between two holds of one run: released 10 s ago is go, 400 s ago is not now; ask is always checked', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MAX_LOAD=4\n')
    const locks = join(m.cache, 'locks')
    mkdirSync(locks, { recursive: true })
    const hot = { ...calm, HEAVY_GUARD_LOAD1: '30', HEAVY_GUARD_NOW: String(NOW) }
    utimesSync(locks, NOW - 10, NOW - 10)
    expect(m.g(['gate'], hot).status).toBe(0)
    expect(m.g(['ask', '1'], hot).status).toBe(75)
    utimesSync(locks, NOW - 299, NOW - 299)
    expect(m.g(['gate'], hot).status).toBe(0)
    utimesSync(locks, NOW - 400, NOW - 400)
    expect(m.first(m.g(['gate'], hot))).toBe('not now: load is 30 on 10 cores (limit 4)')
    // the settle time is a setting
    expect(m.g(['gate'], { ...hot, HEAVY_GUARD_LOAD_SETTLE_S: '600' }).status).toBe(0)
    m.conf('HEAVY_GUARD_MAX_LOAD=4\nHEAVY_GUARD_LOAD_SETTLE_S=0\n')
    utimesSync(locks, NOW - 10, NOW - 10)
    expect(m.g(['gate'], hot).status).toBe(75)
  })

  it('a release really moves the locks folder’s time (what the settle rule reads)', () => {
    const m = machine()
    const locks = join(m.cache, 'locks')
    expect(spawnSync(BASH, [HL, 'run', 'x', '--', 'true'], { env: m.env }).status).toBe(0)
    utimesSync(locks, NOW - 1000, NOW - 1000) // as if long ago, then one more take and release
    expect(spawnSync(BASH, [HL, 'run', 'x', '--', 'true'], { env: m.env }).status).toBe(0)
    expect(statSync(locks).mtimeMs / 1000).toBeGreaterThan(Date.now() / 1000 - 30)
  })

  it('a job that runs inside the holder (heavy-lock.sh held) is not refused for load', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MAX_LOAD=4\n')
    const r = spawnSync(BASH, [HL, 'run', 'outer', '--', BASH, '-c', `bash "${HL}" held && ${BASH} "${HG}" inner`], {
      env: { ...m.env, ...calm, HEAVY_GUARD_LOAD1: '30' },
      encoding: 'utf8',
      timeout: 30_000,
    })
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout.trim()).toBe('go')
  })
})

describe('heavy-guard.sh ask: may I use <gb> GB now?', () => {
  it('free after taking <gb> must stay at or above the floor', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\n')
    const p = { ...calm, HEAVY_GUARD_FREE_PCT: '50', HEAVY_GUARD_MEM_GB: '32' }
    const r = m.g(['ask', '4'], p) // 50 - 4/32*100 = 37.5
    expect(r.status).toBe(75)
    expect(m.first(r)).toBe('not now: memory is tight (37.5% free after 4 GB, needs 40%)')
    const ok = m.g(['ask', '3'], p) // 40.625
    expect([ok.status, m.first(ok)]).toEqual([0, 'go'])
    expect(m.g(['ask', '3.2'], p).status).toBe(0) // exactly 40
    expect(m.g(['ask', '3.21'], p).status).toBe(75)
    expect(m.g(['ask', '4'], { ...p, HEAVY_GUARD_MEM_GB: 'x' }).status).toBe(0) // total unknown: skipped
  })

  it('bad sizes are usage (64), on or off (ask alone is a job name)', () => {
    const m = machine()
    for (const args of [
      ['ask', '0'],
      ['ask', '-1'],
      ['ask', 'abc'],
      ['ask', '4GB'],
      ['ask', '1.2.3'],
      ['ask', ''],
    ]) {
      expect(m.g(args).status, args.join(' ')).toBe(64)
    }
    expect(m.g(['ask', '1', 'who', 'extra']).status).toBe(64)
  })

  it('an unconfigured machine answers go, and says nobody is checking', () => {
    const m = machine()
    const r = m.g(['ask', '20'], { HEAVY_GUARD_FREE_PCT: '1', HEAVY_GUARD_MEM_GB: '8' })
    expect([r.status, m.first(r)]).toEqual([0, 'guard off: nobody is checking'])
  })

  it('a window booked by someone else blocks; the asker\u2019s own window does not', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    m.bookings(`${at('2026-11-12T11:00')}\t${at('2026-11-12T13:00')}\tencoder\tvideo\n`)
    const e = { ...calm, HEAVY_GUARD_NOW: String(NOW) }
    expect(m.first(m.g(['ask', '2'], e))).toBe('not now: booked for encoder until 13:00 (video)')
    expect(m.g(['ask', '2', 'someone'], e).status).toBe(75)
    expect(m.g(['ask', '2', 'encoder'], e).status).toBe(0)
  })
})

describe('heavy-guard.sh book and unbook', () => {
  const on = (m: ReturnType<typeof machine>) => m.conf('HEAVY_GUARD_BOOKINGS=1\n')
  const e = { HEAVY_GUARD_NOW: String(NOW) }

  it('books HH:MM today and the full form, prints it, writes a 0600 file outside the repo', () => {
    const m = machine()
    on(m)
    const r = m.g(['book', 'alpha', '13:00', '14:30', 'a', 'long', 'eval'], e)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('booked for alpha from 13:00 to 14:30 (a long eval)\n')
    const b = m.g(['book', 'beta', '2026-11-12T15:00', '2026-11-12T16:00'], e)
    expect(b.stdout).toBe('booked for beta from 15:00 to 16:00\n')
    expect(m.read()).toBe(
      `${at('2026-11-12T13:00')}\t${at('2026-11-12T14:30')}\talpha\ta long eval\n${at('2026-11-12T15:00')}\t${at('2026-11-12T16:00')}\tbeta\t\n`,
    )
    expect(statSync(join(m.gdir, 'bookings.tsv')).mode & 0o777).toBe(0o600)
  })

  it('a window across midnight in the full form; "until" names the day when it is not today', () => {
    const m = machine()
    on(m)
    const r = m.g(['book', 'night', '2026-11-12T22:00', '2026-11-13T02:00', 'overnight'], e)
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toBe('booked for night from 22:00 to 2026-11-13 02:00 (overnight)\n')
    const late = m.g(['gate'], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-12T23:30')) })
    expect(m.first(late)).toBe('not now: booked for night until 2026-11-13 02:00 (overnight)')
    const after = m.g(['gate'], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-13T01:00')) })
    expect(m.first(after)).toBe('not now: booked for night until 02:00 (overnight)')
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-13T02:00')) }).status).toBe(0)
  })

  it('refuses (65, one sentence) end before start, over 12 hours, an overlap with someone else, an ended window', () => {
    const m = machine()
    on(m)
    m.g(['book', 'alpha', '13:00', '15:00'], e)
    const cases: [string[], string][] = [
      [['book', 'x', '14:00', '13:00'], 'refused: the window ends before it starts'],
      [['book', 'x', '14:00', '14:00'], 'refused: the window ends before it starts'],
      [['book', 'x', '2026-11-12T13:00', '2026-11-13T01:01'], 'refused: a window may be 12 hours at most'],
      [['book', 'x', '14:59', '16:00'], 'refused: that window overlaps a booking by alpha from 13:00 to 15:00'],
      [['book', 'x', '09:00', '11:00'], 'refused: that window has already ended'],
    ]
    for (const [args, says] of cases) {
      const r = m.g(args, e)
      expect([r.status, r.stderr.trim()], args.join(' ')).toEqual([65, says])
    }
    expect(m.g(['book', 'x', '15:00', '16:00'], e).status).toBe(0) // touching is not overlapping
    expect(m.g(['book', 'alpha', '13:30', '14:30'], e).status).toBe(0) // the same person may overlap their own
  })

  it('refuses control characters and over-long names or notes; bad times are usage', () => {
    const m = machine()
    on(m)
    const refused: string[][] = [
      ['book', 'a\u0001b', '13:00', '14:00'],
      ['book', 'a\tb', '13:00', '14:00'],
      ['book', 'ab', '13:00', '14:00', 'line\nbreak'],
      ['book', 'ab', '13:00', '14:00', 'esc\u001b[31m'],
      ['book', 'x'.repeat(41), '13:00', '14:00'],
      ['book', 'ab', '13:00', '14:00', 'n'.repeat(121)],
    ]
    for (const args of refused) expect(m.g(args, e).status, JSON.stringify(args)).toBe(65)
    expect(m.g(['book', 'x'.repeat(40), '13:00', '14:00', 'n'.repeat(120)], e).status).toBe(0)
    expect(m.g(['book', '\u00e9'.repeat(40), '14:00', '14:30'], e).status).toBe(0) // characters, not bytes
    for (const t of ['25:00', '1pm', '2026-02-30T10:00', '13:60', ''])
      expect(m.g(['book', 'ab', t, '23:00'], e).status, t).toBe(64)
    expect(m.g(['book', 'ab', '13:00'], e).status).toBe(64)
    expect(existsSync(join(m.gdir, 'bookings.tsv'))).toBe(true)
    // nothing but tabs and newlines below a space
    expect([...m.read()].filter((c) => c < ' ' && c !== '\t' && c !== '\n')).toEqual([])
  })

  it('refuses while bookings are off, and says how to turn them on', () => {
    const m = machine()
    const r = m.g(['book', 'alpha', '13:00', '14:00'], e)
    expect(r.status).toBe(65)
    expect(r.stderr).toContain('init --bookings')
    expect(existsSync(join(m.gdir, 'bookings.tsv'))).toBe(false)
  })

  it('past bookings and lines that do not parse are dropped at the next write; good lines survive', () => {
    const m = machine()
    on(m)
    m.bookings(
      [
        `${at('2026-11-12T08:00')}\t${at('2026-11-12T09:00')}\tpast\told`,
        'garbage line',
        `${at('2026-11-12T16:00')}\t${at('2026-11-12T15:00')}\tbackwards\t`,
        `${at('2026-11-12T18:00')}\t${at('2026-11-12T19:00')}\tkeep\tlater`,
        '',
      ].join('\n'),
    )
    expect(m.g(['gate'], { ...calm, ...e }).status).toBe(0) // the only live one is later
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-12T18:30')) }).status).toBe(75)
    m.g(['book', 'new', '13:00', '14:00'], e)
    expect(m.read()).toBe(
      `${at('2026-11-12T13:00')}\t${at('2026-11-12T14:00')}\tnew\t\n${at('2026-11-12T18:00')}\t${at('2026-11-12T19:00')}\tkeep\tlater\n`,
    )
  })

  it('unbook removes that person\u2019s bookings, or only the one starting at <from>', () => {
    const m = machine()
    on(m)
    m.g(['book', 'a', '13:00', '14:00'], e)
    m.g(['book', 'a', '15:00', '16:00'], e)
    m.g(['book', 'b', '17:00', '18:00'], e)
    expect(m.g(['unbook', 'a', '15:00'], e).stdout).toBe('removed 1 booking for a\n')
    expect(m.read()).not.toContain(`${at('2026-11-12T15:00')}`)
    expect(m.g(['unbook', 'a'], e).stdout).toBe('removed 1 booking for a\n')
    expect(m.g(['unbook', 'a'], e).stdout).toBe('no bookings for a\n')
    expect(m.read()).toBe(`${at('2026-11-12T17:00')}\t${at('2026-11-12T18:00')}\tb\t\n`)
  })

  it('concurrent writers: eight books at once all land; two for the same window, one wins', async () => {
    const m = machine()
    on(m)
    const run = (args: string[]) =>
      new Promise<number | null>((res) => {
        const c = spawn(BASH, [HG, ...args], { env: { ...m.env, ...e } })
        kids.push(c)
        c.on('exit', (code) => res(code))
      })
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) => run(['book', `p${i}`, `2026-11-13T0${i}:00`, `2026-11-13T0${i}:30`])),
    )
    expect(all).toEqual(Array(8).fill(0))
    expect(m.read().trim().split('\n')).toHaveLength(8)
    expect(readdirSync(m.gdir).filter((f) => f.includes('.tmp.'))).toEqual([]) // no half-written file left
    const race = await Promise.all([
      run(['book', 'left', '2026-11-13T10:00', '2026-11-13T11:00']),
      run(['book', 'right', '2026-11-13T10:30', '2026-11-13T11:30']),
    ])
    expect(race.sort()).toEqual([0, 65])
    expect(m.read().trim().split('\n')).toHaveLength(9)
  })

  it('a lock file left by a writer that died never blocks', () => {
    const m = machine()
    on(m)
    const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim()
    mkdirSync(m.gdir, { recursive: true })
    writeFileSync(join(m.gdir, 'bookings.tsv.flock'), `${gone}\n`)
    expect(m.g(['book', 'a', '13:00', '14:00'], e).status).toBe(0)
  })
})

describe('heavy-guard.sh init and off', () => {
  it('init writes guard.env (0600) with only the settings given; off removes it', () => {
    const m = machine()
    const r = m.g(['init', '--min-free-pct', '40', '--bookings'])
    expect(r.status, r.stderr).toBe(0)
    const f = join(m.gdir, 'guard.env')
    expect(statSync(f).mode & 0o777).toBe(0o600)
    expect(readFileSync(f, 'utf8')).toMatch(/\nHEAVY_GUARD_MIN_FREE_PCT=40\nHEAVY_GUARD_BOOKINGS=1\n$/)
    expect(readFileSync(f, 'utf8')).not.toContain('MAX_LOAD')
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_FREE_PCT: '30' }).status).toBe(75)
    expect(m.g(['off', 'now']).status).toBe(64) // only --yes
    expect(existsSync(f)).toBe(true)
    expect(m.g(['off', '--yes']).status).toBe(0)
    expect(existsSync(f)).toBe(false)
    expect(m.first(m.g(['gate'], { ...calm, HEAVY_GUARD_FREE_PCT: '30' }))).toBe(
      'go: guard off on this machine (no guard.env)',
    )
  })

  it('init refuses bad values as usage (init alone is a job name)', () => {
    const m = machine()
    for (const args of [
      ['init', '--min-free-pct', '0'],
      ['init', '--min-free-pct', '101'],
      ['init', '--max-load', '0'],
      ['init', '--max-load', 'x'],
      ['init', '--what'],
    ])
      expect(m.g(args).status, args.join(' ')).toBe(64)
    expect(existsSync(join(m.gdir, 'guard.env'))).toBe(false)
  })
})

describe('heavy-guard.sh status', () => {
  const named = (argv0: string) => {
    const c = spawn('perl', ['-e', 'exec {"sleep"} $ARGV[0], "30"', argv0])
    kids.push(c)
    return c
  }

  it('reports settings, memory, load, bookings, the lock, the last refusal, and the lists-and-refuses line', () => {
    const m = machine()
    m.g(['init', '--min-free-pct', '40', '--max-load', '12', '--bookings'])
    m.bookings(
      `${at('2026-11-12T11:00')}\t${at('2026-11-12T13:00')}\tnow-one\tfirst\n${at('2026-11-12T14:00')}\t${at('2026-11-12T15:00')}\tlater-one\t\n`,
    )
    const p = { ...calm, HEAVY_GUARD_NOW: String(NOW), HEAVY_GUARD_STRAY_MIN: '0' }
    let s = m.g(['status'], p)
    expect(s.status).toBe(0)
    expect(s.stdout).toContain('guard: on, from guard.env\n')
    expect(s.stdout).toContain('memory: 90% free (test override) of 32 GB (test override), floor 40%\n')
    expect(s.stdout).toContain('load: 1.5 (1 min) (test override) on 10 cores (test override), limit 12\n')
    expect(s.stdout).toContain('  now: now-one until 13:00 (first)\n  next: later-one from 14:00 to 15:00\n')
    expect(s.stdout).toContain('heavy lock: free\n')
    expect(s.stdout).toMatch(/last refusal: none since \d{4}-\d\d-\d\d \d\d:\d\d\n/)
    const lines = s.stdout.trim().split('\n')
    expect(lines.at(-1)).toBe(
      'This guard lists and refuses. It never stops a process: the owner of a job stops it, by pid.',
    )
    m.g(['gate'], { ...p, HEAVY_GUARD_FREE_PCT: '31' })
    s = m.g(['status'], p)
    expect(s.stdout).toContain('last refusal: 12:00, booked for now-one until 13:00, job gate\n')
    m.g(['now-one'], { ...p, HEAVY_GUARD_FREE_PCT: '31' })
    expect(m.g(['status'], p).stdout).toContain('last refusal: 12:00, memory 31% free, floor 40%, job now-one\n')
  })

  it('says when a setting is ignored, and never errors on unknown probes', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=0\nHEAVY_GUARD_MAX_LOAD=lots\n')
    const s = m.g(['status'], {
      HEAVY_GUARD_FREE_PCT: 'x',
      HEAVY_GUARD_LOAD1: 'x',
      HEAVY_GUARD_CORES: 'x',
      HEAVY_GUARD_NOW: 'x',
    })
    expect(s.status).toBe(0)
    expect(s.stdout).toContain('memory: unknown free')
    expect(s.stdout).toContain('is not a percentage from 1 to 100: the floor is off')
    expect(s.stdout).toContain('load: unknown (1 min) (test override) on unknown cores (test override), limit off')
  })

  it('possible strays: lists a heavy-looking process outside the lock, never the holder\u2019s, never `tmux -L talos`', async () => {
    const m = machine()
    const tag = `t${process.pid}x${Date.now()}`
    const stray = named(`vitest-stray-${tag} --run`)
    const server = named(`tmux -L talos -f /home/alex/.talos/tmux.conf new-session vitest-${tag}`)
    const testServer = named(`tmux -L talos-test-${tag} new-session`)
    // the lock's holder runs a heavy-looking command in its own group
    const h = spawn(
      BASH,
      [HL, 'run', 'held', '--', 'perl', '-e', 'exec {"sleep"} $ARGV[0], "30"', `vitest-held-${tag}`],
      {
        env: m.env,
      },
    )
    kids.push(h)
    await m.until(() => existsSync(join(m.cache, 'locks', 'mutex-suites', 'owner')))
    await m.until(() => spawnSync('ps', ['-A', '-o', 'args=']).stdout.toString().includes(`vitest-held-${tag}`))
    const s = m.g(['status'], { HEAVY_GUARD_STRAY_MIN: '0' })
    expect(s.status).toBe(0)
    const [head, out] = s.stdout.split('possible strays')
    expect(head).toMatch(/heavy lock: held by pid \d+ \(held: perl/)
    expect(out).toMatch(
      new RegExp(`  pid ${stray.pid}, running \\dh\\d\\dm, [0-9.]+% CPU, \\d+ MB: vitest-stray-${tag} --run`),
    )
    expect(out).toContain(`pid ${testServer.pid}, `)
    expect(out).not.toContain(`vitest-held-${tag}`)
    expect(out).not.toContain(`pid ${server.pid},`)
    expect(out).not.toContain(`vitest-${tag}`)
    // over the age limit: none of ours is that old
    expect(m.g(['status'], { HEAVY_GUARD_STRAY_MIN: '600' }).stdout.split('possible strays')[1]).not.toContain(tag)
    for (const k of [stray, server, testServer]) expect(k.exitCode).toBe(null) // listed, never stopped
  })

  it('a holder in any slot of the heavy lock is no stray, and status names every slot', async () => {
    const m = machine()
    const tag = `t${process.pid}x${Date.now()}`
    const hold = (n: number) => {
      const h = spawn(
        BASH,
        [HL, 'run', `held${n}`, '--', 'perl', '-e', 'exec {"sleep"} $ARGV[0], "30"', `vitest-held${n}-${tag}`],
        { env: { ...m.env, TALOS_HEAVY_SLOTS: '3' } },
      )
      kids.push(h)
      return h
    }
    const a = hold(1)
    await m.until(() => existsSync(join(m.cache, 'locks', 'mutex-suites-2', 'owner')))
    const b = hold(2)
    await m.until(() => existsSync(join(m.cache, 'locks', 'mutex-suites-3', 'owner')))
    await m.until(() => spawnSync('ps', ['-A', '-o', 'args=']).stdout.toString().includes(`vitest-held2-${tag}`))
    const s = m.g(['status'], { HEAVY_GUARD_STRAY_MIN: '0', TALOS_HEAVY_SLOTS: '3' })
    const [head, out] = s.stdout.split('possible strays')
    expect(head).toMatch(new RegExp(`slot 2: held by pid ${a.pid} \\(held1: `))
    expect(head).toMatch(new RegExp(`slot 3: held by pid ${b.pid} \\(held2: `))
    expect(out).not.toContain(`vitest-held1-${tag}`)
    expect(out).not.toContain(`vitest-held2-${tag}`) // slot 3's command is the lock's own work too
  })
})

describe('never blocks by mistake', () => {
  const tight = { HEAVY_GUARD_MIN_FREE_PCT: '99', HEAVY_GUARD_MAX_LOAD: '0.01', HEAVY_GUARD_BOOKINGS: '1' }
  const covering = (m: ReturnType<typeof machine>) => {
    const now = Math.floor(Date.now() / 1000)
    m.bookings(`${now - 600}\t${now + 3600}\tsomeone-else\t\n`, now - 600)
  }

  it('an unconfigured machine, with probes that would refuse', () => {
    const m = machine()
    expect(m.g(['gate'], { HEAVY_GUARD_FREE_PCT: '1', HEAVY_GUARD_LOAD1: '999' }).status).toBe(0)
  })

  it('every probe failing: the tools missing from PATH', () => {
    const m = machine()
    covering(m)
    const empty = join(m.cache, 'empty-bin')
    mkdirSync(empty)
    const r = spawnSync(BASH, [HG, 'gate'], { env: { HOME: m.cache, TALOS_CI_CACHE: m.cache, PATH: empty, ...tight } })
    expect(r.status, String(r.stdout)).toBe(0)
  })

  it('every probe failing: tools that print garbage', () => {
    const m = machine()
    covering(m)
    const bin = join(m.cache, 'bin')
    mkdirSync(bin)
    const junk: Record<string, string> = {
      memory_pressure: 'System-wide memory free percentage: lots%',
      sysctl: '{ x y z }',
      uptime: 'up forever, load averages: high, higher, highest',
      nproc: 'many',
      getconf: 'many',
      date: 'soon',
    }
    for (const [t, out] of Object.entries(junk))
      writeFileSync(join(bin, t), `#!/bin/sh\necho '${out}'\n`, { mode: 0o755 })
    // Twice: with no proc files (the probes ask those tools, as on a Mac) and with garbage proc files (Linux reads files, not
    // tools). Left to the real /proc, this machine's own reading decided instead (92% free met the 99% floor on Titan).
    const none = join(m.cache, 'no-proc')
    const junkProc = join(m.cache, 'proc')
    mkdirSync(none)
    mkdirSync(junkProc)
    writeFileSync(join(junkProc, 'meminfo'), 'MemTotal: lots kB\nMemAvailable: plenty kB\nSwapTotal: x kB\n')
    writeFileSync(join(junkProc, 'loadavg'), 'high higher highest\n')
    for (const proc of [none, junkProc]) {
      const r = m.g(['gate'], { PATH: `${bin}:${m.env.PATH}`, HEAVY_GUARD_PROC: proc, ...tight })
      expect(r.status, `${proc}: ${r.stdout}`).toBe(0)
    }
  })

  it('a bookings file that is malformed, unreadable, a directory, or 10 MB', () => {
    const now = String(NOW)
    const make: Record<string, (p: string) => void> = {
      malformed: (p) => writeFileSync(p, '\u0000\u0001garbage\t\t\t\nx\ty\tz\tw\n-1\t-2\ta\tb\n'),
      unreadable: (p) => {
        writeFileSync(p, `${NOW - 60}\t${NOW + 60}\tother\t\n`)
        chmodSync(p, 0o000)
      },
      directory: (p) => mkdirSync(p),
      huge: (p) => writeFileSync(p, `${'z'.repeat(1023)}\n`.repeat(10 * 1024)),
    }
    for (const [name, f] of Object.entries(make)) {
      const m = machine()
      mkdirSync(m.gdir, { recursive: true })
      f(join(m.gdir, 'bookings.tsv'))
      const r = m.g(['gate'], { ...calm, HEAVY_GUARD_BOOKINGS: '1', HEAVY_GUARD_NOW: now })
      // unreadable is only unreadable to a non-root user
      if (name !== 'unreadable' || process.getuid?.() !== 0) expect(r.status, name).toBe(0)
      expect(m.g(['status'], { ...calm, HEAVY_GUARD_BOOKINGS: '1', HEAVY_GUARD_NOW: now }).status, name).toBe(0)
    }
  })

  it('a guard.env with junk lines, a non-numeric threshold, a threshold of 0 or above 100', () => {
    const probes = { HEAVY_GUARD_FREE_PCT: '1', HEAVY_GUARD_LOAD1: '999', HEAVY_GUARD_CORES: '2' }
    for (const body of [
      'rm -rf /\n$(touch pwned)\nexport HEAVY_GUARD_MIN_FREE_PCT\n=40\n',
      'HEAVY_GUARD_MIN_FREE_PCT=forty\nHEAVY_GUARD_MAX_LOAD=high\n',
      'HEAVY_GUARD_MIN_FREE_PCT=0\nHEAVY_GUARD_MAX_LOAD=0\n',
      'HEAVY_GUARD_MIN_FREE_PCT=101\nHEAVY_GUARD_MAX_LOAD=-3\n',
      'HEAVY_GUARD_MIN_FREE_PCT=$(echo 50)\nHEAVY_GUARD_MAX_LOAD=`echo 1`\n',
    ]) {
      const m = machine()
      m.conf(body)
      const r = m.g(['gate'], probes)
      expect(r.status, body).toBe(0)
      expect(existsSync(join(m.cache, 'pwned'))).toBe(false)
      expect(existsSync(join(here, 'pwned'))).toBe(false)
    }
  })

  it('a clock that cannot be read', () => {
    const m = machine()
    covering(m)
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_BOOKINGS: '1', HEAVY_GUARD_NOW: 'later' }).status).toBe(0)
    const bin = join(m.cache, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'date'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_BOOKINGS: '1', PATH: `${bin}:${m.env.PATH}` }).status).toBe(0)
  })

  it('the cache directory missing, or read-only (a refusal there is still a refusal, its record silently skipped)', () => {
    const m = machine()
    const missing = join(m.cache, 'not', 'there')
    expect(
      m.g(['gate'], { ...calm, HEAVY_GUARD_MIN_FREE_PCT: '40', HEAVY_GUARD_BOOKINGS: '1', TALOS_CI_CACHE: missing })
        .status,
    ).toBe(0)
    expect(m.g(['status'], { TALOS_CI_CACHE: missing }).status).toBe(0)
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\n')
    chmodSync(m.gdir, 0o555)
    chmodSync(m.cache, 0o555)
    try {
      expect(m.g(['gate'], calm).status).toBe(0)
      const r = m.g(['gate'], { ...calm, HEAVY_GUARD_FREE_PCT: '10' })
      expect([r.status, m.first(r)]).toEqual([75, 'not now: memory is tight (10% free, needs 40%)'])
      if (process.getuid?.() !== 0) expect(existsSync(join(m.gdir, 'last-refusal'))).toBe(false)
    } finally {
      chmodSync(m.cache, 0o755)
      chmodSync(m.gdir, 0o755)
    }
  })

  it('an empty environment (env -i)', () => {
    const r = spawnSync('/usr/bin/env', ['-i', BASH, HG, 'gate'], { encoding: 'utf8' })
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const a = spawnSync('/usr/bin/env', ['-i', BASH, HG, 'ask', '8'], { encoding: 'utf8' })
    expect(a.status).toBe(0)
  })

  it('the script has exactly one `exit 75`, and NOT_NOW is set only right after a comparison of two parsed numbers', () => {
    const lines = readFileSync(HG, 'utf8').split('\n')
    const code = lines.map((l) => l.replace(/^\s*#.*$/, ''))
    const exits = code.map((l, i) => [l, i] as const).filter(([l]) => /\bexit 75\b/.test(l))
    expect(exits).toHaveLength(1)
    const [, at75] = exits[0]
    // it sits in finish, under the NOT_NOW test
    const fn = code.slice(0, at75).reverse()
    expect(fn.find((l) => /^[a-z_]+\(\) \{/.test(l))).toMatch(/^finish\(\) \{/)
    expect(code.slice(at75 - 4, at75).join('\n')).toContain('if [ -n "$NOT_NOW" ]; then')
    // every assignment of a not-now line comes right after `if/elif num_lt|num_gt|num_le ... then`
    const sets = code.map((l, i) => [l, i] as const).filter(([l]) => /\bNOT_NOW="/.test(l) && !/NOT_NOW=""/.test(l))
    expect(sets.length).toBeGreaterThanOrEqual(4)
    for (const [, i] of sets) expect(code[i - 1], `line ${i + 1}`).toMatch(/^\s*(if|elif) num_(lt|gt|le) .*; then$/)
    // and those helpers are true only for two numbers that pass is_num
    for (const f of ['num_lt', 'num_gt', 'num_le'])
      expect(code.find((l) => l.startsWith(`${f}() {`))).toMatch(/\{ is_num "\$1" && is_num "\$2" && perl /)
  })
})

describe('heavy-guard.sh only lists and refuses', () => {
  it('sends one signal only, in one place: bounded stopping its own probe’s group; no pkill, killall or renice', () => {
    const lines = readFileSync(HG, 'utf8')
      .split('\n')
      .map((l) => l.replace(/^\s*#.*$/, '').replace(/\s#\s.*$/, ''))
    expect(lines.join('\n')).not.toMatch(/\b(pkill|killall|renice)\b/)
    const kills = lines.map((l, i) => [l, i] as const).filter(([l]) => /\bkill\b/i.test(l))
    expect(kills).toHaveLength(1)
    const [line, at] = kills[0]
    // inside the BOUNDED helper, aimed at the group of the probe it forked itself
    const start = lines.findIndex((l) => l.startsWith("BOUNDED='"))
    const end = lines.findIndex((l, i) => i > start && l === "'")
    expect(start).toBeGreaterThan(-1)
    expect(at > start && at < end).toBe(true)
    expect(line).toMatch(/kill "KILL", -\$pid;/)
    expect(lines.slice(start, at).join('\n')).toContain('my $pid = fork;')
    expect(lines.slice(start, at).join('\n')).toContain('setpgrp(0, 0)')
  })

  it('bounded: a probe killed by a signal exits 128+n, never 0 (its output is no answer); a plain exit keeps its code', () => {
    const src = readFileSync(HG, 'utf8')
    const body = /\nBOUNDED='\n([\s\S]*?)\n'\n/.exec(src)?.[1]
    expect(body).toBeTruthy()
    const run = (...cmd: string[]) => spawnSync('perl', ['-e', body as string, '10', '', ...cmd], { encoding: 'utf8' })
    expect(run('sh', '-c', 'echo half; kill -KILL $$').status).toBe(137)
    expect(run('sh', '-c', 'kill -TERM $$').status).toBe(143)
    expect(run('sh', '-c', 'echo ok; exit 3').status).toBe(3)
    const fine = run('sh', '-c', 'echo ok')
    expect([fine.status, fine.stdout]).toEqual([0, 'ok\n'])
  })

  it('assumes no home folder: every path comes from TALOS_CI_CACHE, HOME or the script’s own folder', () => {
    const src = readFileSync(HG, 'utf8')
    expect(src).not.toMatch(/\/Users\/|\/home\//)
  })

  it('is executable, where ci_guard looks for it by default', () => {
    expect(statSync(HG).mode & 0o111).not.toBe(0)
    expect(readFileSync(join(here, 'ci-local/locks.sh'), 'utf8')).toContain('/../heavy-guard.sh}')
  })
})

describe('one argument is always a job name (the hook form), except status, --help and -h', () => {
  // heavy-lock.sh calls the guard with whatever name a caller gave `run <name>`: a name must never act as a command
  const reserved = ['off', 'init', 'book', 'unbook', 'ask', 'check', 'help', '--yes', '-x', '--min-free-pct']
  const setup = () => {
    const m = machine()
    m.g(['init', '--min-free-pct', '40', '--max-load', '12', '--bookings'])
    m.bookings(`${at('2026-11-12T14:00')}\t${at('2026-11-12T15:00')}\tsomeone\tlater\n`)
    const snap = () => [readFileSync(join(m.gdir, 'guard.env')), readFileSync(join(m.gdir, 'bookings.tsv'))]
    return { m, snap, before: snap() }
  }

  it('each reserved word alone is a job: go when nothing refuses, files byte-identical', () => {
    const { m, snap, before } = setup()
    for (const w of reserved) {
      const r = m.g([w], { ...calm, HEAVY_GUARD_NOW: String(NOW) })
      // stderr: only test mode's own warning (these run with HEAVY_GUARD_TEST=1), nothing else
      expect([r.status, m.first(r), r.stderr], w).toEqual([
        0,
        'go',
        "heavy-guard: WARNING: HEAVY_GUARD_TEST=1 is set: test overrides are in force, this answer is not the machine's\n",
      ])
      expect(snap(), w).toEqual(before)
    }
  })

  it('each reserved word alone is refused like any job while someone else’s booking covers now', () => {
    const { m, snap, before } = setup()
    for (const w of reserved) {
      const r = m.g([w], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-12T14:30')) })
      expect([r.status, m.first(r)], w).toEqual([75, 'not now: booked for someone until 15:00 (later)'])
      expect(snap(), w).toEqual(before)
    }
    expect(readFileSync(join(m.gdir, 'last-refusal'), 'utf8')).toMatch(/, job --min-free-pct\n$/)
  })

  it('status, --help and -h keep their meaning', () => {
    const { m } = setup()
    expect(m.g(['status'], calm).stdout.split('\n')[1]).toBe('guard: on, from guard.env')
    for (const h of ['--help', '-h']) expect(m.g([h]).stdout).toContain('heavy-guard.sh off --yes')
  })

  it('hostile job names are data: spaces, quotes, $(...), a newline, 5,000 characters', () => {
    const { m, snap, before } = setup()
    const names = [
      'a job with spaces',
      `it's "quoted"`,
      `$(touch ${m.cache}/pwned)`,
      '`touch pwned`',
      'two\nlines',
      '%s%n%d',
      '*',
      'x'.repeat(5000),
    ]
    for (const n of names) {
      const go = m.g([n], { ...calm, HEAVY_GUARD_NOW: String(NOW) })
      expect([go.status, m.first(go)], n.slice(0, 40)).toEqual([0, 'go'])
      const no = m.g([n], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-12T14:30')) })
      expect(no.status, n.slice(0, 40)).toBe(75)
      const rec = readFileSync(join(m.gdir, 'last-refusal'), 'utf8')
      expect(rec.split('\n')).toHaveLength(2) // one line
      expect(rec.length).toBeLessThan(300) // the name clipped to 80 characters
      expect(snap()).toEqual(before)
    }
    expect(existsSync(join(m.cache, 'pwned'))).toBe(false)
    expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false)
    const rec = m.g(['two\nlines'], { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-12T14:30')) })
    expect(rec.status).toBe(75)
    expect(readFileSync(join(m.gdir, 'last-refusal'), 'utf8')).toMatch(/, job twolines\n$/)
  })

  it('the booker’s own job matches on the cleaned name: compared after control characters are stripped and the name clipped to 80', () => {
    const { m } = setup()
    const e = { ...calm, HEAVY_GUARD_NOW: String(at('2026-11-12T14:30')) }
    expect(m.g(['someone'], e).status).toBe(0)
    expect(m.g(['some\none'], e).status).toBe(0) // control characters are stripped before the compare
    expect(m.g([`someone${' '.repeat(80)}x`], e).status).toBe(75)
  })

  it('two words that are not a command are usage, not a job', () => {
    const { m } = setup()
    expect(m.g(['gate', 'extra']).status).toBe(64)
    expect(m.g(['off', '--yes', 'more']).status).toBe(64)
  })
})

describe('the hook end to end: heavy-lock.sh run waits while the guard says not now', () => {
  it('a booked window holds a job back until it ends (the clock read from a file each ask); the booker’s own job runs', async () => {
    const m = machine()
    const clock = join(m.cache, 'clock')
    writeFileSync(clock, `${NOW}\n`)
    m.bookings(`${at('2026-11-12T11:00')}\t${at('2026-11-12T13:00')}\tbooker\tdemo\n`)
    const env = {
      ...m.env,
      ...calm,
      HEAVY_GUARD_BOOKINGS: '1',
      HEAVY_GUARD_NOW_FILE: clock,
      TALOS_HEAVY_GUARD: HG,
      HEAVY_LOCK_TIMEOUT: '30',
    }
    const own = spawnSync(BASH, [HL, 'run', 'booker', '--', 'echo', 'ran'], { env, encoding: 'utf8' })
    expect([own.status, own.stdout]).toEqual([0, 'ran\n'])
    expect(own.stderr).not.toContain('not now')
    const out: string[] = []
    const c = spawn(BASH, [HL, 'run', 'gate', '--', 'echo', 'ran'], { env })
    kids.push(c)
    c.stderr?.on('data', (d) => out.push(String(d)))
    c.stdout?.on('data', (d) => out.push(`OUT:${d}`))
    const done = new Promise((r) => c.on('exit', r))
    await m.until(() => out.join('').includes('the guard says not now'))
    expect(out.join('')).toContain('the guard says not now (not now: booked for booker until 13:00 (demo))')
    await sleep(500)
    expect(out.join('')).not.toContain('OUT:') // still held back
    writeFileSync(clock, `${at('2026-11-12T13:00')}\n`) // the window has ended
    expect(await done).toBe(0)
    expect(out.join('')).toContain('OUT:ran\n')
  })

  it('HEAVY_GUARD_NOW wins over the file; a file that is missing or garbage is an unknown clock (go)', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    m.bookings(`${at('2026-11-12T11:00')}\t${at('2026-11-12T13:00')}\tother\t\n`)
    const clock = join(m.cache, 'clock')
    writeFileSync(clock, `${at('2026-11-12T14:00')}\n`)
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_NOW_FILE: clock, HEAVY_GUARD_NOW: String(NOW) }).status).toBe(75)
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_NOW_FILE: clock }).status).toBe(0)
    writeFileSync(clock, 'noon\n')
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_NOW_FILE: clock }).status).toBe(0)
    expect(m.g(['gate'], { ...calm, HEAVY_GUARD_NOW_FILE: join(m.cache, 'none') }).status).toBe(0)
  })

  it('an unconfigured guard never holds a job back', () => {
    const m = machine()
    const r = spawnSync(BASH, [HL, 'run', 'gate', '--', 'echo', 'ran'], {
      env: { ...m.env, TALOS_HEAVY_GUARD: HG, HEAVY_GUARD_FREE_PCT: '1', HEAVY_LOCK_TIMEOUT: '5' },
      encoding: 'utf8',
    })
    expect([r.status, r.stdout, r.stderr]).toEqual([0, 'ran\n', ''])
  })

  it('a symlinked guard path works too (TALOS_HEAVY_GUARD may name a link)', () => {
    const m = machine()
    const link = join(m.cache, 'guard-link')
    symlinkSync(HG, link)
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\n')
    const r = spawnSync(BASH, [HL, 'run', 'gate', '--', 'echo', 'ran'], {
      env: { ...m.env, ...calm, HEAVY_GUARD_FREE_PCT: '10', TALOS_HEAVY_GUARD: link, HEAVY_LOCK_TIMEOUT: '1' },
      encoding: 'utf8',
    })
    expect(r.status).toBe(75)
    expect(r.stderr).toContain('the guard says not now (not now: memory is tight (10% free, needs 40%))')
  })
})

describe('bookings: only rows `book` could have written count (reader and writer alike)', () => {
  const e = { ...calm, HEAVY_GUARD_BOOKINGS: '1', HEAVY_GUARD_NOW: String(NOW) }
  const S = NOW - 60 // started a minute ago
  it('rows book would never write are dropped and never refuse', () => {
    const bad = [
      `${S}\t${Date.UTC(9999, 0, 1) / 1000}\tforever\t`, // ends in 9999
      `${S}\t${S + 13 * 3600}\ttoo-long\t`, // 13 hours
      `${NOW + 49 * 3600}\t${NOW + 50 * 3600}\tfar-ahead\t`, // starts more than 48 hours ahead (not live now anyway)
      `${S}\t${NOW + 3600}\t${'w'.repeat(41)}\t`, // a name over 40
      `${S}\t${NOW + 3600}\tctl\u0001x\t`, // a control character
      `${S}\t${NOW + 3600}\tfive\tfields\textra`, // a tab too many
      `${S}\t${NOW + 3600}\tthree`, // a field short
      `${S}\t${NOW + 3600}\tlong-note\t${'n'.repeat(121)}`,
    ]
    for (const row of bad) {
      const m = machine()
      m.bookings(`${row}\n`)
      const r = m.g(['gate'], e)
      expect([r.status, r.stdout], row.slice(0, 60)).toEqual([0, 'go\n'])
    }
    // the same rows, cleaned up at the next write (a well-formed row is kept even when it starts far ahead: the reader's
    // stamp rule decides whether it counts); a good one beside them still counts
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    m.bookings(`${bad.join('\n')}\n${S}\t${NOW + 3600}\tgood\tok\n`)
    expect(m.first(m.g(['gate'], e))).toBe('not now: booked for good until 13:00 (ok)')
    expect(m.g(['book', 'other', '14:00', '15:00'], e).status).toBe(0)
    expect(m.read()).toBe(
      `${S}\t${NOW + 3600}\tgood\tok\n${at('2026-11-12T14:00')}\t${at('2026-11-12T15:00')}\tother\t\n${NOW + 49 * 3600}\t${NOW + 50 * 3600}\tfar-ahead\t\n`,
    )
  })

  it('unbook can remove anything the reader honours (a 40-character name); unbook --all --yes always works', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    const forty = 'q'.repeat(40)
    m.bookings(`${S}\t${NOW + 3600}\t${forty}\t\n`)
    expect(m.g(['gate'], e).status).toBe(75)
    expect(m.g(['unbook', forty], e).stdout).toBe(`removed 1 booking for ${forty}\n`)
    expect(m.g(['gate'], e).status).toBe(0)
    m.bookings('\u0000\u0001 garbage that no unbook <who> could name\n')
    expect(m.g(['unbook', '--all'], e).status).toBe(64)
    const all = m.g(['unbook', '--all', '--yes'], e)
    expect([all.status, all.stdout]).toEqual([0, 'removed every booking (bookings.tsv, bookings.tsv.flock)\n'])
    expect(existsSync(join(m.gdir, 'bookings.tsv'))).toBe(false)
    mkdirSync(join(m.gdir, 'bookings.tsv')) // even a folder where the file should be
    expect(m.g(['unbook', '--all', '--yes'], e).status).toBe(0)
    expect(existsSync(join(m.gdir, 'bookings.tsv'))).toBe(false)
  })

  it('no endless booking: a start at most 48 hours ahead, 12 hours per name, 20 rows', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    const no = (args: string[], says: string) => {
      const r = m.g(args, e)
      expect([r.status, r.stderr.trim()], args.join(' ')).toEqual([65, says])
    }
    no(['book', 'a', '2026-11-14T12:01', '2026-11-14T13:00'], 'refused: a window may start at most 48 hours from now')
    expect(m.g(['book', 'a', '2026-11-14T12:00', '2026-11-14T13:00'], e).status).toBe(0)
    expect(m.g(['book', 'a', '2026-11-13T00:00', '2026-11-13T11:00'], e).status).toBe(0) // 1 + 11 = 12 hours
    no(['book', 'a', '2026-11-13T20:00', '2026-11-13T20:01'], 'refused: a would have more than 12 hours booked')
    expect(m.g(['unbook', 'a'], e).status).toBe(0)
    m.bookings(
      `${Array.from({ length: 20 }, (_, i) => `${NOW + i * 3600}\t${NOW + i * 3600 + 600}\tp${i}\t`).join('\n')}\n`,
    )
    no(['book', 'late', '2026-11-14T10:00', '2026-11-14T10:30'], 'refused: there are 20 bookings already')
  })

  it('the writer lock: a live writer holds the next one back; one that died (or a pid since reused) never does', async () => {
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    const lockFile = join(m.gdir, 'bookings.tsv.flock')
    // a writer holding the lock for 1.5 s
    const holder = spawn('perl', [
      '-MFcntl=:flock',
      '-e',
      'open my $f, ">>", $ARGV[0] or die; flock($f, LOCK_EX) or die; print "held\\n"; $| = 1; select(undef, undef, undef, 1.5)',
      lockFile,
    ])
    kids.push(holder)
    await new Promise((r) => holder.stdout?.once('data', r))
    const t0 = Date.now()
    const run = (args: string[]) =>
      new Promise<number | null>((res) => {
        const c = spawn(BASH, [HG, ...args], { env: { ...m.env, ...e } })
        kids.push(c)
        c.on('exit', (code) => res(code))
      })
    expect(await run(['book', 'a', '13:00', '14:00'])).toBe(0)
    expect(Date.now() - t0).toBeGreaterThan(1000) // it waited for the holder
    // the lock file stays behind with nobody holding it, as after a writer killed mid-write; an old-style lock folder too
    expect(existsSync(lockFile)).toBe(true)
    mkdirSync(join(m.gdir, 'bookings.lock'), { recursive: true })
    writeFileSync(join(m.gdir, 'bookings.lock', 'pid'), `${process.pid}\n`) // a live pid: this test runner
    const t1 = Date.now()
    expect(m.g(['book', 'b', '15:00', '16:00'], e).status).toBe(0)
    expect(Date.now() - t1).toBeLessThan(3000)
  })
})

describe('probe overrides are for tests only', () => {
  it('without HEAVY_GUARD_TEST=1 a leftover override is ignored; the machine is read', () => {
    const m = machine()
    // a 2% floor: the leftover 1% override refuses, while the real machine (Linux reads /proc/meminfo, not the fake below)
    // passes under any load short of exhaustion; at 40 a busy runner refused here (report-ci/linux at 66b727c)
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=2\nHEAVY_GUARD_BOOKINGS=1\n')
    m.bookings(`${NOW - 60}\t${NOW + 3600}\tother\t\n`)
    const bin = join(m.cache, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'memory_pressure'), '#!/bin/sh\necho "System-wide memory free percentage: 90%"\n', {
      mode: 0o755,
    })
    const leftover = { PATH: `${bin}:${m.env.PATH}`, HEAVY_GUARD_FREE_PCT: '1', HEAVY_GUARD_NOW: String(NOW) }
    expect(m.g(['gate'], { ...leftover, HEAVY_GUARD_TEST: '' }).status).toBe(0) // real clock: the booking is long over
    expect(m.g(['gate'], leftover).status).toBe(75) // in test mode, the overrides count
    const s = m.g(['status'], leftover).stdout
    expect(s.split('\n')[0]).toBe(
      'warning: HEAVY_GUARD_TEST=1: readings marked (test override) come from variables, not this machine',
    )
    expect(s).toContain('memory: 1% free (test override)')
    const real = m.g(['status'], { ...leftover, HEAVY_GUARD_TEST: '' }).stdout
    expect(real).not.toContain('test override')
    if (!existsSync('/proc/meminfo')) expect(real).toContain('memory: 90% free')
  })
})

describe('HEAVY_GUARD_PROC is a test seam only', () => {
  it.skipIf(!existsSync('/proc/meminfo'))('without HEAVY_GUARD_TEST=1 it is ignored: the real /proc is read', () => {
    const m = machine()
    const proc = join(m.cache, 'proc')
    mkdirSync(proc)
    writeFileSync(join(proc, 'meminfo'), 'MemTotal: 1000 kB\nMemAvailable: 10 kB\n')
    expect(m.g(['status'], { HEAVY_GUARD_PROC: proc }).stdout).toContain('memory: 1% free')
    expect(m.g(['status'], { HEAVY_GUARD_PROC: proc, HEAVY_GUARD_TEST: '' }).stdout).not.toContain('memory: 1% free')
  })
  it('test mode is loud on every command, on stderr after the answer; a real run says nothing of it', () => {
    const m = machine()
    for (const args of [['gate'], ['check', 'x'], ['ask', '1'], ['status']]) {
      const t = m.g(args)
      expect(t.stderr, args.join(' ')).toContain('heavy-guard: WARNING: HEAVY_GUARD_TEST=1 is set')
      expect(m.g(args, { HEAVY_GUARD_TEST: '' }).stderr, args.join(' ')).not.toContain('WARNING')
    }
  })
})

describe('a deadline on every probe', () => {
  it('probes that hang: the hook still answers go within about 5 s, and their processes are stopped', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=99\nHEAVY_GUARD_MAX_LOAD=0.01\nHEAVY_GUARD_BOOKINGS=1\n')
    const bin = join(m.cache, 'bin')
    mkdirSync(bin)
    for (const t of ['memory_pressure', 'sysctl', 'uptime', 'nproc', 'getconf', 'date', 'ps'])
      writeFileSync(join(bin, t), `#!/bin/sh\necho $$ >> "${m.cache}/pids"\nsleep 30\necho 1\n`, { mode: 0o755 })
    // No override is set, so every probe asks its tool. On Linux the memory and load probes read /proc instead, which can't hang
    // and gave this machine's real reading (under the 99% floor): an empty folder in its place sends them to the tools too.
    const proc = join(m.cache, 'no-proc')
    mkdirSync(proc)
    const t0 = Date.now()
    const r = m.g(['gate'], { PATH: `${bin}:${m.env.PATH}`, HEAVY_GUARD_PROC: proc })
    const took = Date.now() - t0
    expect([r.status, r.stdout]).toEqual([0, 'go\n'])
    expect(took).toBeLessThan(7000)
    const pids = readFileSync(join(m.cache, 'pids'), 'utf8').trim().split('\n').map(Number)
    expect(pids.length).toBeGreaterThan(0)
    spawnSync('sleep', ['0.3'])
    for (const p of pids) expect(spawnSync('ps', ['-p', String(p)]).status, `pid ${p}`).not.toBe(0)
  })

  it('status with hanging probes still finishes and says unknown', () => {
    const m = machine()
    const bin = join(m.cache, 'bin')
    mkdirSync(bin)
    for (const t of ['memory_pressure', 'sysctl', 'uptime', 'ps'])
      writeFileSync(join(bin, t), '#!/bin/sh\nsleep 30\n', { mode: 0o755 })
    const r = m.g(['status'], { PATH: `${bin}:${m.env.PATH}`, HEAVY_GUARD_TEST: '' })
    expect(r.status).toBe(0)
    if (!existsSync('/proc/meminfo')) expect(r.stdout).toContain('memory: unknown free')
    expect(r.stdout).toContain('possible strays')
    expect(r.stdout).toContain('This guard lists and refuses.')
  })
})

describe('the live tmux server is never a stray, wherever its -L sits', () => {
  it('-L talos, -Ltalos, -uL talos, after other flags, a full path: never listed; talos-test-… is', async () => {
    const m = machine()
    const tag = `t${process.pid}y${Date.now()}`
    const named = (argv0: string) => {
      const c = spawn('perl', ['-e', 'exec {"sleep"} $ARGV[0], "30"', argv0])
      kids.push(c)
      return c
    }
    const live = [
      named(`tmux -Ltalos new-session vitest-${tag}`),
      named(`tmux -u -L talos new-session vitest-${tag}`),
      named(`tmux -uL talos attach vitest-${tag}`),
      named(`/opt/bin/tmux -f /home/alex/x.conf -L talos new vitest-${tag}`),
    ]
    const test = named(`tmux -f /home/alex/x.conf -L talos-test-${tag} new vitest`)
    await m.until(() => spawnSync('ps', ['-A', '-o', 'args=']).stdout.toString().includes(`talos-test-${tag}`))
    const out = m.g(['status'], { HEAVY_GUARD_STRAY_MIN: '0' }).stdout.split('possible strays')[1]
    for (const k of live) expect(out).not.toContain(`pid ${k.pid},`)
    expect(out).not.toContain(`vitest-${tag}`)
    expect(out).toContain(`pid ${test.pid},`)
  })
})

describe('ci_guard tells the guard which cache its lock is in', () => {
  it('a ci-local style caller with TALOS_CI_CACHE unset: the guard reads that cache’s guard.env, not HOME’s', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MIN_FREE_PCT=40\n')
    const home = tmp() // another home, with no guard.env at all
    // what ci-local.sh does: its own CACHE, TALOS_CI_CACHE unset, then ci_mutex on <cache>/locks
    const script = `
      CI_LOCAL_LIB="${join(here, 'ci-local')}"
      CI_NONCE="t-$$" CI_HELD="" CI_SLOT="" CI_MARKER="" CI_MSG=ci-test CI_POLL=0.1 CI_LOCK_TIMEOUT=2 CI_LOCK_GRACE=30
      CI_RUNS="${m.cache}/runs"
      . "$CI_LOCAL_LIB/locks.sh"
      CI_MUTEX_JOB=quiet ci_mutex "${m.cache}/locks" suites echo ran
    `
    const env: Record<string, string> = {
      PATH: m.env.PATH,
      HOME: home,
      TZ: 'UTC',
      TALOS_HEAVY_GUARD: HG,
      HEAVY_GUARD_TEST: '1',
      HEAVY_GUARD_FREE_PCT: '10',
    }
    const r = spawnSync(BASH, ['-c', script], { env, encoding: 'utf8', timeout: 30_000 })
    expect(r.stdout).not.toContain('ran')
    expect(r.stderr).toContain('the guard says not now (not now: memory is tight (10% free, needs 40%))')
    const ok = spawnSync(BASH, ['-c', script], { env: { ...env, HEAVY_GUARD_FREE_PCT: '90' }, encoding: 'utf8' })
    expect([ok.status, ok.stdout]).toEqual([0, 'ran\n'])
  })
})

describe('a bookings file stops refusing at most 60 hours after its last write, whatever it holds', () => {
  const e = { ...calm, HEAVY_GUARD_BOOKINGS: '1' }
  const at_ = (t: number) => ({ ...e, HEAVY_GUARD_NOW: String(t) })
  it('a hand-written chain of ten 12-hour rows: refused now and up to 60 h after the write, go after', () => {
    const m = machine()
    m.bookings(
      `${Array.from({ length: 10 }, (_, i) => `${NOW + i * 43200}\t${NOW + (i + 1) * 43200}\tchain\t`).join('\n')}\n`,
      NOW,
    )
    expect(m.g(['gate'], at_(NOW + 60)).status).toBe(75)
    expect(m.g(['gate'], at_(NOW + 59 * 3600)).status).toBe(75) // the row starting at the stamp + 48 h
    expect(m.g(['gate'], at_(NOW + 60 * 3600)).status).toBe(0)
    expect(m.g(['gate'], at_(NOW + 100 * 3600)).status).toBe(0)
  })

  it('a stamp more than a minute ahead of the clock is no bookings; up to a minute is fine', () => {
    const m = machine()
    m.bookings(`${NOW - 60}\t${NOW + 3600}\tother\t\n`, NOW + 120)
    expect(m.g(['gate'], at_(NOW)).status).toBe(0)
    m.bookings(`${NOW - 60}\t${NOW + 3600}\tother\t\n`, NOW + 50)
    expect(m.g(['gate'], at_(NOW)).status).toBe(75)
  })

  it('only the first 20 well-formed rows count', () => {
    const m = machine()
    const later = Array.from(
      { length: 20 },
      (_, i) => `${NOW + 7200 + i * 600}\t${NOW + 7200 + i * 600 + 300}\tp${i}\t`,
    )
    m.bookings(`${[...later, `${NOW - 60}\t${NOW + 3600}\tlate-row\t`].join('\n')}\n`)
    expect(m.g(['gate'], at_(NOW)).status).toBe(0)
    m.bookings(`${[`${NOW - 60}\t${NOW + 3600}\tlate-row\t`, ...later].join('\n')}\n`)
    expect(m.first(m.g(['gate'], at_(NOW)))).toBe('not now: booked for late-row until 13:00')
  })

  it('a clock stepped back never costs a booking: a write keeps every well-formed row that has not ended', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    expect(m.g(['book', 'far', '2026-11-14T11:00', '2026-11-14T12:00'], at_(NOW)).status).toBe(0) // +47 h
    expect(statSync(join(m.gdir, 'bookings.tsv')).mtimeMs / 1000).toBe(NOW) // stamped with the guard clock
    expect(m.g(['unbook', 'nobody'], at_(NOW - 2 * 3600)).status).toBe(0) // a write with the clock two hours back
    expect(statSync(join(m.gdir, 'bookings.tsv')).mtimeMs / 1000).toBe(NOW) // the stamp did not move back
    expect(m.read()).toContain('\tfar\t')
    expect(m.g(['gate'], at_(at('2026-11-14T11:30'))).status).toBe(75) // and it still holds when its time comes
  })
})

describe('unbook --all --yes needs no lock', () => {
  const e = { ...calm, HEAVY_GUARD_BOOKINGS: '1', HEAVY_GUARD_NOW: String(NOW) }
  it('works while another process holds the lock', async () => {
    const m = machine()
    m.bookings(`${NOW - 60}\t${NOW + 3600}\tother\t\n`)
    const lockFile = join(m.gdir, 'bookings.tsv.flock')
    const holder = spawn('perl', [
      '-MFcntl=:flock',
      '-e',
      'open my $f, ">>", $ARGV[0] or die; flock($f, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 20',
      lockFile,
    ])
    kids.push(holder)
    await new Promise((r) => holder.stdout?.once('data', r))
    const t0 = Date.now()
    const r = m.g(['unbook', '--all', '--yes'], e)
    expect([r.status, r.stdout]).toEqual([0, 'removed every booking (bookings.tsv, bookings.tsv.flock)\n'])
    expect(Date.now() - t0).toBeLessThan(3000)
    expect(m.g(['gate'], e).status).toBe(0)
  })

  it('works when the lock path is a folder, and book then says what is wrong without blaming another writer', () => {
    const m = machine()
    m.conf('HEAVY_GUARD_BOOKINGS=1\n')
    mkdirSync(join(m.gdir, 'bookings.tsv.flock'), { recursive: true })
    const b = m.g(['book', 'a', '13:00', '14:00'], e)
    expect(b.status).toBe(65)
    expect(b.stderr).toMatch(
      /^refused: cannot open the bookings lock file .*bookings\.tsv\.flock \(.+\); unbook --all --yes clears it\n$/,
    )
    expect(b.stderr).not.toContain('another writer')
    const r = m.g(['unbook', '--all', '--yes'], e)
    expect([r.status, r.stdout]).toEqual([0, 'removed every booking (bookings.tsv.flock)\n'])
    expect(m.g(['book', 'a', '13:00', '14:00'], e).status).toBe(0)
    expect(m.g(['unbook', '--all', '--yes'], e).stdout).toBe(
      'removed every booking (bookings.tsv, bookings.tsv.flock)\n',
    )
    expect(m.g(['unbook', '--all', '--yes'], e).stdout).toBe('removed every booking\n') // nothing left: still 0
  })
})

describe('status says whether the load limit is live right now, and why not', () => {
  it('live, skipped while settling (with the seconds), skipped while held', async () => {
    const m = machine()
    m.conf('HEAVY_GUARD_MAX_LOAD=12\n')
    const p = { ...calm, HEAVY_GUARD_NOW: String(NOW) }
    expect(m.g(['status'], p).stdout).toContain('\nload limit 12: live\n')
    const locks = join(m.cache, 'locks')
    mkdirSync(locks, { recursive: true })
    utimesSync(locks, NOW - 40, NOW - 40)
    expect(m.g(['status'], p).stdout).toContain(
      '\nload limit 12: skipped, the lock changed hands 40 s ago (settles for 300 s)\n',
    )
    utimesSync(locks, NOW - 400, NOW - 400)
    expect(m.g(['status'], p).stdout).toContain('\nload limit 12: live\n')
    const h = spawn(BASH, [HL, 'run', 'h', '--', 'sh', '-c', `: > "${m.cache}/held"; sleep 20`], { env: m.env })
    kids.push(h)
    await m.until(() => existsSync(join(m.cache, 'held')))
    expect(m.g(['status'], p).stdout).toMatch(
      /\nload limit 12: skipped, the heavy lock is held by pid \d+ \(its load is its own\)\n/,
    )
  })
})
