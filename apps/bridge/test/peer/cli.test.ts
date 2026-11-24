// `talos-app peer create|add|list|remove|rotate` against a fake relay (the FakeRelay's peer routes) and a key store in memory.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../../src/cli.ts'
import { ConfigFile } from '../../src/config-file.ts'
import { PEER_SECRET_SERVICE, PEERS_INBOUND_FILE, peerSecretAccount, readInboundPeers } from '../../src/peer/records.ts'
import { type Harness, startHarness } from '../helpers.ts'
import { FAKE_SECRET, memorySecrets } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

async function cli(argv: string[], o: { secret?: string; terminal?: boolean } = {}) {
  const out: string[] = []
  const err: string[] = []
  const secrets = (h as Harness & { secrets?: ReturnType<typeof memorySecrets> }).secrets as ReturnType<
    typeof memorySecrets
  >
  let asked = 0
  const code = await runCli(
    argv,
    {
      isTerminal: o.terminal ?? true,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async () => {
        asked++
        return ''
      },
      readSecret: async () => {
        asked++
        return o.secret ?? ''
      },
      sleep: async () => {},
      now: () => Date.now(),
    },
    { TALOS_APP_HOME: (h as Harness).home, TALOS_APP_RELAY_URL: (h as Harness).relay.httpUrl },
    { peer: { secrets } },
  )
  return { code, out: out.join('\n'), err: err.join('\n'), asked }
}

async function start() {
  h = Object.assign(await startHarness({ startBridge: false }), { secrets: memorySecrets() })
  return h
}
const config = () => new ConfigFile(join((h as Harness).home, 'config.json')).load()

describe('talos-app peer', () => {
  test('create makes the inbox, prints url and secret once, and records the connection locally (0600)', async () => {
    await start()
    const r = await cli(['peer', 'create', 'work', '--cap', '20'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toMatch(/url: +https?:\/\/\S+\/hook\/peer\/cn_/)
    expect(r.out).toMatch(/secret: +whsec_/)
    expect(r.out).toContain('talos-app peer add')
    const row = (h as Harness).relay.peers.rows[0]
    expect(row?.name).toBe('work')
    expect(row?.cap).toBe(20)
    expect(readInboundPeers((h as Harness).home)).toEqual([{ name: 'work', conn_id: row?.conn_id as string }])
    expect(statSync(join((h as Harness).home, PEERS_INBOUND_FILE)).mode & 0o777).toBe(0o600)
    // the call was bridge-signed
    expect(
      (h as Harness).relay.http.some(
        (x) =>
          x.path === '/bridge/peers' && x.status === 201 && String(x.headers.authorization).startsWith('TalosBridge'),
      ),
    ).toBe(true)
    const again = await cli(['peer', 'create', 'work'])
    expect(again.code).toBe(1)
    expect(again.err).toContain('already an inbox named "work"')
    expect((await cli(['peer', 'create', 'owner'])).code).toBe(1) // a reserved name
  })

  test('add reads the secret from the terminal, never argv, and stores it and the config entry', async () => {
    await start()
    const r = await cli(['peer', 'add', 'work', '--url', 'https://relay.example.com/hook/peer/cn_abc', '--cap', '9'], {
      secret: FAKE_SECRET,
    })
    expect(r.code, r.err).toBe(0)
    expect(r.asked).toBe(1)
    expect(r.out).not.toContain(FAKE_SECRET)
    const secrets = (h as unknown as { secrets: ReturnType<typeof memorySecrets> }).secrets
    expect(await secrets.get(PEER_SECRET_SERVICE, peerSecretAccount('work'))).toBe(FAKE_SECRET)
    expect(config().peers).toEqual([{ name: 'work', url: 'https://relay.example.com/hook/peer/cn_abc', daily_cap: 9 }])
    // a secret on the command line is refused wherever it is, and nothing is written
    const argv = await cli(['peer', 'add', 'x', '--url', 'https://a.example.com/h', FAKE_SECRET])
    expect(argv.code).toBe(1)
    expect(argv.err).toContain('never goes on the command line')
    expect(
      (await cli(['peer', 'add', 'x', '--url', 'https://a.example.com/h', `--secret=${FAKE_SECRET}`])).code,
    ).not.toBe(0)
    expect(config().peers.map((p) => p.name)).toEqual(['work'])
    // not https, not a secret
    expect((await cli(['peer', 'add', 'y', '--url', 'http://a.example.com/h'], { secret: FAKE_SECRET })).code).toBe(1)
    const bad = await cli(['peer', 'add', 'y', '--url', 'https://a.example.com/h'], { secret: 'not-a-secret' })
    expect(bad.code).toBe(1)
    expect(bad.err).not.toContain('not-a-secret')
    expect(config().peers).toHaveLength(1)
  })

  test('list shows the host only, the caps, the counts and whether the secret is there', async () => {
    await start()
    await cli(['peer', 'create', 'work'])
    await cli(['peer', 'add', 'work', '--url', 'https://other.example.com/hook/peer/cn_secrettoken'], {
      secret: FAKE_SECRET,
    })
    const r = await cli(['peer', 'list'])
    expect(r.code, r.err).toBe(0)
    expect(r.out).toContain('other.example.com')
    expect(r.out).not.toContain('cn_secrettoken')
    expect(r.out).toContain('secret yes')
    expect(r.out).toContain('received today 0')
    expect(r.out).toContain('sent today 0')
    const secrets = (h as unknown as { secrets: ReturnType<typeof memorySecrets> }).secrets
    secrets.data.clear()
    expect((await cli(['peer', 'list'])).out).toContain('secret no')
  })

  test('rotate prints the new secret once and says how long the old one lives', async () => {
    await start()
    await cli(['peer', 'create', 'work'])
    const old = (h as Harness).relay.peers.rows[0]?.secrets[0]
    const r = await cli(['peer', 'rotate', 'work'])
    expect(r.code, r.err).toBe(0)
    const fresh = /secret: +(whsec_\S+)/.exec(r.out)?.[1]
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe(old)
    expect(r.out).toContain('24 hours')
    expect(r.out).toContain('peer remove work')
    expect(r.out).toContain('peer create work')
    const none = await cli(['peer', 'rotate', 'nope'])
    expect(none.code).toBe(1)
  })

  test('remove takes away the inbox, the secret, the config entry and the local record; each may already be gone', async () => {
    await start()
    await cli(['peer', 'create', 'work'])
    await cli(['peer', 'add', 'work', '--url', 'https://other.example.com/hook/peer/cn_x'], { secret: FAKE_SECRET })
    const r = await cli(['peer', 'remove', 'work'])
    expect(r.code, r.err).toBe(0)
    expect((h as Harness).relay.peers.rows).toHaveLength(0)
    expect(readInboundPeers((h as Harness).home)).toEqual([])
    expect(config().peers).toEqual([])
    const secrets = (h as unknown as { secrets: ReturnType<typeof memorySecrets> }).secrets
    expect(await secrets.get(PEER_SECRET_SERVICE, peerSecretAccount('work'))).toBeUndefined()
    // again, and with only some of it left
    expect((await cli(['peer', 'remove', 'work'])).code).toBe(0)
    await cli(['peer', 'add', 'work', '--url', 'https://other.example.com/hook/peer/cn_x'], { secret: FAKE_SECRET })
    expect((await cli(['peer', 'remove', 'work'])).code).toBe(0)
    expect(config().peers).toEqual([])
    expect(
      existsSync(join((h as Harness).home, PEERS_INBOUND_FILE))
        ? readFileSync(join((h as Harness).home, PEERS_INBOUND_FILE), 'utf8')
        : '',
    ).not.toContain('work')
  })

  test('the agent runs it (agent-secrets.test.ts has the rest); an unknown subcommand is named as one, and the guards still say terminal-only', async () => {
    await start()
    const r = await cli(['peer', 'create', 'work'], { terminal: false })
    expect(r.code, r.err).toBe(0)
    expect((h as Harness).relay.peers.rows).toHaveLength(1)
    const bogus = (await cli(['peer', 'bogus'], { terminal: false })).err
    expect(bogus).toContain("`peer bogus` isn't a talos-app command")
    expect(bogus).not.toContain('only runs in')
    const { terminalOnly } = await import('../../src/talos.ts')
    expect(terminalOnly(['peer', 'add', 'work'])).toBe('peer')
  })

  test('add warns when there is no inbox of the same name, create warns when there is no peer of that name', async () => {
    await start()
    const add = await cli(['peer', 'add', 'work', '--url', 'https://other.example.com/hook/peer/cn_x'], {
      secret: FAKE_SECRET,
    })
    expect(add.code, add.err).toBe(0)
    expect(add.out).toContain('no inbox named "work"')
    expect(add.out).toContain('both sides must use the same name')
    const create = await cli(['peer', 'create', 'work'])
    expect(create.code, create.err).toBe(0)
    expect(create.out).not.toContain('both sides must use the same name') // the peer of that name exists
    const other = await cli(['peer', 'create', 'play'])
    expect(other.out).toContain('no peer named "play"')
    expect(other.out).toContain('both sides must use the same name')
    const addPlay = await cli(['peer', 'add', 'play', '--url', 'https://other.example.com/hook/peer/cn_y'], {
      secret: FAKE_SECRET,
    })
    expect(addPlay.out).not.toContain('both sides must use the same name')
  })
})
