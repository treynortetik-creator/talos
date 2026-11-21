// `talos-app relay connect | disconnect | status`: a Railway token pasted once, kept in the key store, never anywhere else.

import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { readConnection, writeOwnFile } from '../../src/relay/files.ts'
import { homeScopeSuffix } from '../../src/secrets/home-scope.ts'
import {
  allFiles,
  cli,
  ENV_ID,
  FAKE_ACCOUNT_TOKEN,
  FAKE_PROJECT_TOKEN,
  OTHER_SERVICE_ID,
  PROJECT_ID,
  RELAY_SERVICE_ID,
  world,
} from './helpers.ts'

const file = (home: string) => join(home, 'relay-connect.json')
const stored = (w: ReturnType<typeof world>) => [...w.secrets.data.entries()]

describe('relay connect with a project token', () => {
  test('is identified by the project header, named, confirmed and stored', async () => {
    const w = world()
    const r = await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    expect(r.code, r.all).toBe(0)
    expect(r.out).toContain('Project → Settings → Tokens')
    expect(r.out).toContain("this token can read your relay's settings")
    expect(r.out).toContain('relay service: relay, environment production')
    expect(r.out).toContain('auto-update is on')
    expect(r.out).toContain('talos-app relay auto off')
    const f = JSON.parse(readFileSync(file(w.home), 'utf8'))
    expect(f).toMatchObject({
      v: 1,
      via: 'token',
      kind: 'project',
      project_id: PROJECT_ID,
      environment_id: ENV_ID,
      service_id: RELAY_SERVICE_ID,
      auto_update: true,
    })
    expect(typeof f.connected_at).toBe('number')
    expect(statSync(file(w.home)).mode & 0o777).toBe(0o600)
    // the key store holds the token, under this home's own name
    expect(stored(w)).toHaveLength(1)
    const [[key, value]] = stored(w) as [[string, string]]
    expect(value).toBe(FAKE_PROJECT_TOKEN)
    expect(key).toBe(`com.talos.app.railway.${homeScopeSuffix(w.home)}\u0000relay`)
    // identified with the project header only, never the bearer one
    const first = w.railway.calls[0]
    expect(first?.op).toBe('projectToken')
    expect(first?.projectHeader).toBe(FAKE_PROJECT_TOKEN)
    expect(first?.authHeader).toBeUndefined()
    // the relay's host matched a service's domain, so the service id was never asked for
    expect(r.asked.some((q) => /service id/i.test(q))).toBe(false)
  })
  test('no domain matches: the service id is asked for, and checked against the project', async () => {
    const w = world({ railway: { relayDomain: 'nothing.example.test' } })
    const r = await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: [OTHER_SERVICE_ID, 'y'] })
    expect(r.code, r.all).toBe(0)
    expect(r.asked.some((q) => /service id/i.test(q))).toBe(true)
    expect(r.out).toContain('relay service: worker, environment production')
    expect(JSON.parse(readFileSync(file(w.home), 'utf8')).service_id).toBe(OTHER_SERVICE_ID)
  })
  test('a service id that is not an id, or not in this project, stores nothing', async () => {
    const w = world({ railway: { relayDomain: 'nothing.example.test' } })
    for (const bad of ['not an id!', 'aaaaaaaa-0000-4000-8000-000000000000']) {
      const r = await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: [bad, 'y'] })
      expect(r.code, bad).toBe(1)
    }
    expect(existsSync(file(w.home))).toBe(false)
    expect(stored(w)).toHaveLength(0)
  })
  test('answering no at the confirmation stores nothing', async () => {
    const w = world()
    const r = await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['n'] })
    expect(r.code).toBe(1)
    expect(existsSync(file(w.home))).toBe(false)
    expect(stored(w)).toHaveLength(0)
  })
})

describe('relay connect with a broad token', () => {
  test('warns in the words it was given, and without a typed yes nothing is stored', async () => {
    const w = world()
    for (const answer of ['no', '', 'y']) {
      const r = await cli(w, ['relay', 'connect'], { secret: FAKE_ACCOUNT_TOKEN, answers: [answer] })
      expect(r.code, answer).toBe(1)
      expect(r.out).toContain('this key can change every project in your Railway account; a project key is safer')
    }
    expect(existsSync(file(w.home))).toBe(false)
    expect(stored(w)).toHaveLength(0)
    // it was tried as a project token first, then as a bearer one; and nothing but the identity query ran with it
    const ops = w.railway.calls.map((c) => c.op)
    expect(ops.slice(0, 2)).toEqual(['projectToken', 'me'])
    expect(w.railway.calls.at(-1)?.authHeader).toBe(`Bearer ${FAKE_ACCOUNT_TOKEN}`)
    expect(ops).not.toContain('project')
  })
  test('yes stores it, as an account token, with the service id asked for', async () => {
    const w = world()
    const r = await cli(w, ['relay', 'connect'], {
      secret: FAKE_ACCOUNT_TOKEN,
      answers: ['yes', RELAY_SERVICE_ID, 'y'],
    })
    expect(r.code, r.all).toBe(0)
    const f = JSON.parse(readFileSync(file(w.home), 'utf8'))
    expect(f).toMatchObject({
      via: 'token',
      kind: 'account',
      project_id: PROJECT_ID,
      environment_id: ENV_ID,
      service_id: RELAY_SERVICE_ID,
    })
    expect(stored(w)[0]?.[1]).toBe(FAKE_ACCOUNT_TOKEN)
    expect(r.out).toContain('relay service: relay, environment production')
  })
})

describe('relay connect refuses', () => {
  test('a token on the command line, whatever it looks like', async () => {
    const w = world()
    for (const arg of [FAKE_PROJECT_TOKEN, '5b1f2c3a-0d4e-4f6a-8b7c-9d0e1f2a3b4c', '--token', 'whatever']) {
      const r = await cli(w, ['relay', 'connect', arg], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
      expect(r.code, arg).not.toBe(0)
      expect(r.err).toContain('never goes on the command line')
      if (arg === FAKE_PROJECT_TOKEN) expect(r.all).not.toContain(FAKE_PROJECT_TOKEN)
    }
    expect(w.railway.calls).toHaveLength(0)
    expect(stored(w)).toHaveLength(0)
  })
  test('anything but a terminal', async () => {
    const w = world()
    const r = await cli(w, ['relay', 'connect'], { terminal: false, secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('only runs in')
    expect(r.asked).toHaveLength(0)
    expect(w.railway.calls).toHaveLength(0)
    expect(stored(w)).toHaveLength(0)
  })
  test('a token Railway does not know: says which headers were tried and what to do, stores nothing', async () => {
    const w = world()
    const r = await cli(w, ['relay', 'connect'], { secret: 'rw_FAKE_wrong_0123456789abcdef', answers: ['yes', 'y'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('Project-Access-Token')
    expect(r.err).toContain('Authorization: Bearer')
    expect(r.err).toMatch(/new token|copied/)
    expect(r.all).not.toContain('rw_FAKE_wrong_0123456789abcdef')
    expect(existsSync(file(w.home))).toBe(false)
  })
  test('something that is not shaped like a token, without asking Railway', async () => {
    const w = world()
    const r = await cli(w, ['relay', 'connect'], { secret: 'has spaces in it', answers: ['y'] })
    expect(r.code).toBe(1)
    expect(w.railway.calls).toHaveLength(0)
  })
  test('a relay the Talos app set up (it holds the Railway login)', async () => {
    const w = world()
    writeFileSync(
      file(w.home),
      JSON.stringify({
        v: 1,
        via: 'app',
        project_id: PROJECT_ID,
        environment_id: ENV_ID,
        service_id: RELAY_SERVICE_ID,
        auto_update: true,
      }),
      { mode: 0o600 },
    )
    const r = await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('relay disconnect')
    expect(JSON.parse(readFileSync(file(w.home), 'utf8')).via).toBe('app')
  })
})

describe('where the token goes', () => {
  test('only into the key store: not on stdout, stderr, any file of the home, the log or a prompt', async () => {
    const w = world()
    const runs = [
      await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] }),
      await cli(w, ['relay', 'status']),
      await cli(w, ['relay', 'auto', 'off']),
      await cli(w, ['relay', 'update']),
    ]
    for (const r of runs) expect(r.all).not.toContain(FAKE_PROJECT_TOKEN)
    for (const f of allFiles(w.home)) expect(f.text, f.path).not.toContain(FAKE_PROJECT_TOKEN)
    const f = JSON.parse(readFileSync(file(w.home), 'utf8'))
    for (const key of Object.keys(f)) expect(key).not.toMatch(/token|secret|key|bearer/i)
    expect(stored(w)).toHaveLength(1)
  })
  test('relay-connect.json is never written through a symlink; the token is not left behind', async () => {
    const w = world()
    mkdirSync(w.home, { recursive: true })
    const target = join(w.home, 'elsewhere.json')
    writeFileSync(target, 'keep')
    symlinkSync(target, file(w.home))
    const r = await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    expect(r.code).toBe(1)
    expect(r.err).toContain('symlink')
    expect(readFileSync(target, 'utf8')).toBe('keep')
    expect(lstatSync(file(w.home)).isSymbolicLink()).toBe(true)
    expect(stored(w)).toHaveLength(0)
  })
  test('the writer itself refuses a symlink that appears after the checks (and writes 0600 otherwise)', () => {
    const w = world()
    const target = join(w.home, 'elsewhere.json')
    writeFileSync(target, 'keep')
    symlinkSync(target, file(w.home))
    expect(() => writeOwnFile(file(w.home), { v: 1 })).toThrow(/symlink/)
    expect(readFileSync(target, 'utf8')).toBe('keep')
    writeOwnFile(join(w.home, 'plain.json'), { v: 1 })
    expect(statSync(join(w.home, 'plain.json')).mode & 0o777).toBe(0o600)
  })
  test('a connection file that is a symlink is not read, so nothing is redeployed from it', () => {
    const w = world()
    const real = join(w.home, 'real.json')
    writeFileSync(
      real,
      JSON.stringify({
        v: 1,
        via: 'app',
        project_id: PROJECT_ID,
        environment_id: ENV_ID,
        service_id: RELAY_SERVICE_ID,
        auto_update: true,
      }),
    )
    expect(readConnection(w.home)).toBeUndefined()
    symlinkSync(real, file(w.home))
    expect(readConnection(w.home)).toBeUndefined()
    unlinkSync(file(w.home))
    writeFileSync(file(w.home), readFileSync(real))
    expect(readConnection(w.home)?.file.via).toBe('app')
  })
  test('a connection of another Talos home has its own key store item', async () => {
    const a = world()
    const b = world()
    b.secrets.data.clear()
    const shared = a.secrets
    await cli({ env: a.env, secrets: shared }, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    await cli({ env: b.env, secrets: shared }, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    expect(shared.data.size).toBe(2)
    expect([...shared.data.keys()].sort()).toEqual(
      [a.home, b.home].map((h) => `com.talos.app.railway.${homeScopeSuffix(h)}\u0000relay`).sort(),
    )
  })
})

describe('relay status and disconnect', () => {
  test('status: not connected, then connected (kind, names, auto, no token)', async () => {
    const w = world()
    expect((await cli(w, ['relay', 'status'])).out).toContain('not connected')
    await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    const r = await cli(w, ['relay', 'status'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('project token')
    expect(r.out).toContain('service relay')
    expect(r.out).toContain('environment production')
    expect(r.out).toContain('auto-update: on')
    expect(r.out).toContain('last attempt: none')
  })
  test('disconnect deletes the file and the token, and runs again with nothing to do', async () => {
    const w = world()
    await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    const r = await cli(w, ['relay', 'disconnect'])
    expect(r.code, r.all).toBe(0)
    expect(existsSync(file(w.home))).toBe(false)
    expect(stored(w)).toHaveLength(0)
    const again = await cli(w, ['relay', 'disconnect'])
    expect(again.code).toBe(0)
    expect(again.out).toContain('not connected')
  })
  test('disconnect says what it removed, truthfully: a token with no file, a file with no token, and nothing', async () => {
    const w = world()
    const none = await cli(w, ['relay', 'disconnect'])
    expect(none.out).toContain('nothing to remove')
    expect(none.out).not.toContain('Disconnected')
    // a connect that stopped after the token was kept
    await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    unlinkSync(file(w.home))
    const tokenOnly = await cli(w, ['relay', 'disconnect'])
    expect(tokenOnly.out).toContain('the token is forgotten')
    expect(tokenOnly.out).not.toContain('connection file is removed')
    expect(stored(w)).toHaveLength(0)
    // a file and no token
    await cli(w, ['relay', 'connect'], { secret: FAKE_PROJECT_TOKEN, answers: ['y'] })
    w.secrets.data.clear()
    const fileOnly = await cli(w, ['relay', 'disconnect'])
    expect(fileOnly.out).toContain('there was no token to forget')
    expect(fileOnly.out).toContain('the connection file is removed')
    expect((await cli(w, ['relay', 'disconnect'])).out).toContain('nothing to remove')
  })
  test('disconnect of an app-set-up relay clears only the file and says where the Railway login goes', async () => {
    const w = world()
    writeFileSync(
      file(w.home),
      JSON.stringify({
        v: 1,
        via: 'app',
        project_id: PROJECT_ID,
        environment_id: ENV_ID,
        service_id: RELAY_SERVICE_ID,
        auto_update: true,
      }),
    )
    w.secrets.data.set('x\u0000y', 'untouched')
    const r = await cli(w, ['relay', 'disconnect'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('in the Talos app')
    expect(existsSync(file(w.home))).toBe(false)
    expect(w.secrets.data.get('x\u0000y')).toBe('untouched')
  })
})
