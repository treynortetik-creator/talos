// scripts/lead-inbox.sh: the lead's inbox on GitHub (one issue, one comment per alert), against a fake gh (lead-inbox-fixture.ts)
// that runs the script's own --jq with the real jq. Never the real GitHub.
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { comments, fakeGh, issues } from './lead-inbox-fixture.ts'

const here = dirname(fileURLToPath(import.meta.url))
const hasJq = spawnSync('jq', ['--version']).status === 0
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup() {
  const T = mkdtempSync(join(tmpdir(), 'lead-inbox-'))
  dirs.push(T)
  // a checkout of its own, so the author names the scrub reads are this one's (a made-up person)
  const repo = join(T, 'repo')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  cpSync(join(here, 'lead-inbox.sh'), join(repo, 'scripts/lead-inbox.sh'))
  const git = (author: string, committer: string, ...a: string[]) =>
    spawnSync('git', a, {
      cwd: repo,
      env: {
        PATH: process.env.PATH ?? '',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_AUTHOR_NAME: author,
        GIT_AUTHOR_EMAIL: 'dana@example.com',
        GIT_COMMITTER_NAME: committer,
        GIT_COMMITTER_EMAIL: 'dana@example.com',
      },
    })
  git('Dana Example', 'Dana Example', 'init', '-q', '-b', 'main')
  git('Dana Example', 'Dana Example', 'add', '-A')
  git('Dana Example', 'Dana Example', 'commit', '-qm', 'base')
  // a name with letters beyond ASCII, merged by GitHub's web committer (a tool, not a person)
  git('Zoë Ñandú', 'GitHub', 'commit', '-q', '--allow-empty', '-m', 'second')
  const bin = join(T, 'bin')
  const state = join(T, 'gh')
  fakeGh(bin, state)
  writeFileSync(join(bin, 'hostname'), '#!/bin/sh\necho studio-7.example.net\n', { mode: 0o755 }) // this machine's name
  const cache = join(T, 'cache')
  mkdirSync(join(cache, 'alerts', 'sent'), { recursive: true })
  const reader = join(T, 'reader')
  const env = () => ({
    PATH: `${bin}:${process.env.PATH}`,
    HOME: T,
    USER: 'alexuser', // this machine's login
    TALOS_CI_CACHE: cache,
    TALOS_LEAD_INBOX_HOME: reader,
    GITHUB_REPOSITORY: 'owner/talos-app',
  })
  const run = (...a: string[]) =>
    spawnSync('bash', [join(repo, 'scripts/lead-inbox.sh'), ...a], { cwd: T, env: env(), encoding: 'utf8' })
  const alert = (id: string, text: string, where = 'alerts') => {
    const f = join(cache, where, `${id}.txt`)
    writeFileSync(f, text)
    return f
  }
  const ids = () => comments(state).map((c) => c.body.split('\n')[0])
  return { T, state, cache, reader, env, run, alert, ids }
}

describe.skipIf(!hasJq)('lead-inbox.sh post / flush / note', () => {
  it('makes the "Lead inbox" issue (label lead-inbox) when there is none, then reuses it', () => {
    const s = setup()
    expect(issues(s.state)).toEqual([])
    const f = s.alert('100-aaaaaaa-red', 'main is RED at aaaaaaa: mod\n')
    const r = s.run('post', '100-aaaaaaa-red', f)
    expect(r.status, r.stderr).toBe(0)
    expect(issues(s.state)).toEqual([{ number: 1, title: 'Lead inbox', labels: [{ name: 'lead-inbox' }] }])
    expect(existsSync(join(s.state, 'label-lead-inbox'))).toBe(true)
    const g = s.alert('200-bbbbbbb-green', 'main is green again at bbbbbbb\n')
    expect(s.run('post', '200-bbbbbbb-green', g).status).toBe(0)
    expect(issues(s.state)).toHaveLength(1)
    expect(s.ids()).toEqual(['100-aaaaaaa-red', '200-bbbbbbb-green'])
  })

  it('post is idempotent: the id on the first line, the full text after it, and a second post of the same id adds nothing', () => {
    const s = setup()
    const f = s.alert('100-aaaaaaa-red', 'main is RED at aaaaaaa: mod\nfailing tests:\n  a > b\n')
    expect(s.run('post', '100-aaaaaaa-red', f).status).toBe(0)
    const again = s.run('post', '100-aaaaaaa-red', f)
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('100-aaaaaaa-red is on the issue already')
    expect(comments(s.state)).toHaveLength(1)
    expect(comments(s.state)[0]?.body).toBe('100-aaaaaaa-red\nmain is RED at aaaaaaa: mod\nfailing tests:\n  a > b')
    expect(s.run('flush').status).toBe(0)
    expect(comments(s.state)).toHaveLength(1)
  })

  it('flush posts what a failed post missed (waiting or acked, last 48 h), oldest first, and nothing older or already there', () => {
    const s = setup()
    const a = s.alert('100-aaaaaaa-red', 'main is RED at aaaaaaa\n')
    expect(s.run('post', '100-aaaaaaa-red', a).status).toBe(0)
    writeFileSync(join(s.state, 'fail-post'), '')
    const b = s.alert('200-bbbbbbb-red', 'main is still RED at bbbbbbb\n', 'alerts/sent') // acked by the relay already
    const failed = s.run('post', '200-bbbbbbb-red', b)
    expect(failed.status).toBe(1)
    expect(failed.stderr).toContain('200-bbbbbbb-red could not be posted')
    s.alert('300-ccccccc-untested', 'main UNTESTED\n')
    const old = s.alert('50-0000000-red', 'three days ago\n', 'alerts/sent')
    utimesSync(old, new Date(Date.now() - 72 * 3600_000), new Date(Date.now() - 72 * 3600_000))
    rmSync(join(s.state, 'fail-post'))
    const r = s.run('flush')
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('flush: 2 posted')
    expect(s.ids()).toEqual(['100-aaaaaaa-red', '200-bbbbbbb-red', '300-ccccccc-untested'])
    expect(s.run('flush').stdout).toContain('flush: 0 posted')
  })

  it('note posts free text with a note-<UTC time> id', () => {
    const s = setup()
    const f = join(s.T, 'catch-up.txt')
    writeFileSync(f, 'catch-up: three reds while you were away\n')
    expect(s.run('note', f).status).toBe(0)
    expect(s.ids()[0]).toMatch(/^note-\d{8}T\d{6}Z-\d+$/)
  })

  it('scrubs before posting: home paths become ~, host names <host>, emails <email>, author names <author>', () => {
    const s = setup()
    const f = s.alert(
      '100-aaaaaaa-red',
      'main is RED at aaaaaaa: mod\nlog: /Users/alex/x/run.log and /home/alex/y\non studio-7.example.net (studio-7), build-box.local\nby Dana Example <dana@example.com>\n',
    )
    expect(s.run('post', '100-aaaaaaa-red', f).status).toBe(0)
    const body = comments(s.state)[0]?.body as string
    expect(body).toBe(
      '100-aaaaaaa-red\nmain is RED at aaaaaaa: mod\nlog: ~/x/run.log and ~/y\non <host> (<host>), <host>\nby <author> <<email>>',
    )
    for (const leak of ['/alex', 'studio-7', 'build-box', 'Dana', 'dana@']) expect(body).not.toContain(leak)
  })

  it('scrubs names beyond ASCII and the login, keeps tool names and look-alikes, and neither pings nor links', () => {
    const s = setup()
    const f = s.alert(
      '100-aaaaaaa-red',
      [
        '  abc1234 Zoë Ñandú second',
        'ssh alexuser@10.0.0.5; C:\\Users\\alexuser\\run.log; ALEXUSER',
        'GitHub Actions; https://x.example/home/page; apps/web/.env.local',
        'cc @someone about #123',
        'at file:///Users/alex/a.ts:3; PATH=/usr/bin:/home/alex/bin',
      ].join('\n'),
    )
    expect(s.run('post', '100-aaaaaaa-red', f).status).toBe(0)
    expect(comments(s.state)[0]?.body).toBe(
      [
        '100-aaaaaaa-red',
        '  abc1234 <author> second',
        'ssh <user>`@10.0.0.5`; ~\\run.log; <user>',
        'GitHub Actions; https://x.example/home/page; apps/web/.env.local',
        'cc `@someone` about `#123`',
        'at file://~/a.ts:3; PATH=/usr/bin:~/bin',
      ].join('\n'),
    )
  })

  it('posts nothing when it has no author names to scrub with (not a checkout)', () => {
    const s = setup()
    rmSync(join(s.T, 'repo', '.git'), { recursive: true })
    const r = s.run('post', '100-aaaaaaa-red', s.alert('100-aaaaaaa-red', 'main is RED\n'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('no commit authors to scrub with')
    expect(comments(s.state)).toEqual([])
  })

  it('a lock left by a holder that is gone is taken over', () => {
    const s = setup()
    const lock = join(s.cache, 'lead-inbox.lock')
    mkdirSync(lock)
    writeFileSync(join(lock, 'pid'), '999999\n') // no such process
    expect(s.run('post', '100-aaaaaaa-red', s.alert('100-aaaaaaa-red', 'main is RED\n')).status).toBe(0)
    expect(s.ids()).toEqual(['100-aaaaaaa-red'])
    expect(existsSync(lock)).toBe(false)
  })

  it('a post and a flush at once post an alert once (one poster at a time)', async () => {
    const s = setup()
    for (let i = 0; i < 5; i++) s.alert(`10${i}-aaaaaaa-red`, `main is RED ${i}\n`)
    s.run('post', '000-0000000-red', s.alert('000-0000000-red', 'first\n')) // the issue exists
    writeFileSync(join(s.state, 'slow-read'), '')
    const env = s.env()
    const start = (...a: string[]) =>
      new Promise<number | null>((done) =>
        spawn('bash', [join(s.T, 'repo/scripts/lead-inbox.sh'), ...a], { env, stdio: 'ignore' }).on('exit', done),
      )
    const codes = await Promise.all([
      start('flush'),
      start('post', '104-aaaaaaa-red', join(s.cache, 'alerts/104-aaaaaaa-red.txt')),
      start('flush'),
    ])
    expect(codes).toEqual([0, 0, 0])
    expect(s.ids().sort()).toEqual(['000-0000000-red', ...[0, 1, 2, 3, 4].map((i) => `10${i}-aaaaaaa-red`)])
    expect(existsSync(join(s.cache, 'lead-inbox.lock'))).toBe(false)
  })

  it('refuses to post (exit 3) unless the repository is PRIVATE: no issue, no comment', () => {
    const s = setup()
    writeFileSync(join(s.state, 'visibility'), 'PUBLIC')
    const f = s.alert('100-aaaaaaa-red', 'main is RED\n')
    for (const r of [s.run('post', '100-aaaaaaa-red', f), s.run('flush')]) {
      expect(r.status).toBe(3)
      expect(r.stderr).toContain('refused: owner/talos-app is not private (visibility: PUBLIC)')
    }
    writeFileSync(join(s.state, 'visibility'), '') // unknown is not private either
    expect(s.run('post', '100-aaaaaaa-red', f).status).toBe(3)
    expect(issues(s.state)).toEqual([])
    expect(readFileSync(join(s.state, 'calls'), 'utf8')).not.toContain('POST')
  })
})

describe.skipIf(!hasJq)('lead-inbox.sh unread: the reader catches up', () => {
  it('nothing new: no output, exit 0; new: each id then its text, then "N new (R red)"; --mark only after a print', () => {
    const s = setup()
    s.run('post', '100-aaaaaaa-red', s.alert('100-aaaaaaa-red', 'main is RED at aaaaaaa\n'))
    s.run('post', '200-aaaaaaa-green', s.alert('200-aaaaaaa-green', 'main is green again\n'))
    const first = s.run('unread')
    expect(first.status, first.stderr).toBe(0)
    expect(first.stdout).toBe(
      '100-aaaaaaa-red\nmain is RED at aaaaaaa\n200-aaaaaaa-green\nmain is green again\nlead-inbox: 2 new (1 red)\n',
    )
    expect(s.run('unread').stdout).toBe(first.stdout) // without --mark nothing is remembered
    expect(existsSync(join(s.reader, 'last-read'))).toBe(false)
    expect(s.run('unread', '--mark').stdout).toBe(first.stdout)
    expect(readFileSync(join(s.reader, 'last-read'), 'utf8')).toBe('1007\n')
    const none = s.run('unread', '--mark')
    expect([none.status, none.stdout, none.stderr]).toEqual([0, '', ''])
    s.run('post', '300-bbbbbbb-red', s.alert('300-bbbbbbb-red', 'main is RED at bbbbbbb\n'))
    expect(s.run('unread', '--mark').stdout).toBe(
      '300-bbbbbbb-red\nmain is RED at bbbbbbb\nlead-inbox: 1 new (1 red)\n',
    )
    expect(readFileSync(join(s.reader, 'last-read'), 'utf8')).toBe('1014\n')
  })

  it('cannot read (no inbox issue, or gh fails): one "lead-inbox: cannot read" line on stderr, exit 2, the mark unchanged', () => {
    const s = setup()
    const none = s.run('unread', '--mark')
    expect(none.status).toBe(2)
    expect(none.stdout).toBe('')
    expect(none.stderr.trim().split('\n')).toHaveLength(1)
    expect(none.stderr).toMatch(/^lead-inbox: cannot read/)
    s.run('post', '100-aaaaaaa-red', s.alert('100-aaaaaaa-red', 'main is RED\n'))
    mkdirSync(s.reader, { recursive: true })
    writeFileSync(join(s.reader, 'last-read'), '5\n')
    writeFileSync(join(s.state, 'fail-read'), '')
    const failed = s.run('unread', '--mark')
    expect(failed.status).toBe(2)
    expect(failed.stdout).toBe('')
    expect(failed.stderr).toMatch(/^lead-inbox: cannot read/)
    expect(readFileSync(join(s.reader, 'last-read'), 'utf8')).toBe('5\n')
  })
})
