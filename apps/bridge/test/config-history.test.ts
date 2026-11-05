// config.json keeps its last 20 versions under $TALOS_APP_HOME/config-history/, newest first, and a failing history write
// never stops a config save.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config-file.ts'
import { CONFIG_HISTORY_KEEP } from '../src/config-history.ts'

const defaults = JSON.parse(readFileSync(join(import.meta.dir, '../../../examples/config.default.json'), 'utf8'))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cfh'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify(defaults))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const names = () =>
  readdirSync(join(dir, 'config-history')).sort(
    (a, b) => statSync(join(dir, 'config-history', a)).mtimeMs - statSync(join(dir, 'config-history', b)).mtimeMs,
  ) // oldest first, by mtime
const nameOf = (i: number) => `Agent ${i}`

describe('config version history', () => {
  test('25 writes leave the 20 newest versions, newest first, each the file as it was before a write', () => {
    const file = new ConfigFile(join(dir, 'config.json'))
    file.load()
    expect(CONFIG_HISTORY_KEEP).toBe(20)
    for (let i = 1; i <= 25; i++) file.update((c) => ({ ...c, agent: { ...c.agent, name: nameOf(i) } }))
    const files = names().reverse() // newest first
    expect(files).toHaveLength(20)
    // the version saved by write N holds what write N-1 left: newest is name 24, oldest kept is name 5
    const seen = files.map((f) => JSON.parse(readFileSync(join(dir, 'config-history', f), 'utf8')).agent.name)
    expect(seen).toEqual(Array.from({ length: 20 }, (_, k) => nameOf(24 - k)))
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).agent.name).toBe(nameOf(25))
  })

  test('a version is private to the owner and is the previous file byte for byte', () => {
    const file = new ConfigFile(join(dir, 'config.json'))
    file.load()
    const before = readFileSync(join(dir, 'config.json'), 'utf8')
    file.update((c) => ({ ...c, agent: { ...c.agent, name: 'Atlas' } }))
    const [only] = names()
    expect(names()).toHaveLength(1)
    const p = join(dir, 'config-history', only as string)
    expect(readFileSync(p, 'utf8')).toBe(before)
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test('a failing history write never blocks the save, and is logged', () => {
    writeFileSync(join(dir, 'config-history'), 'in the way') // a file where the folder should be
    const warned: string[] = []
    const log = { warn: (m: string) => warned.push(m) } as never
    const file = new ConfigFile(join(dir, 'config.json'), { log })
    file.load()
    const r = file.update((c) => ({ ...c, agent: { ...c.agent, name: 'Atlas' } }))
    expect(r.agent.name).toBe('Atlas')
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).agent.name).toBe('Atlas')
    expect(warned.some((m) => /config-history/.test(m))).toBe(true)
  })
})

describe('CLI-side history failures are not silent', () => {
  test('trust on logs a history failure to stderr and still saves', async () => {
    const { cmdTrust } = await import('../src/trust-cli.ts')
    writeFileSync(join(dir, 'config-history'), 'in the way')
    const errs: string[] = []
    const code = cmdTrust({ home: dir } as never, ['on'], { out() {}, err: (l: string) => errs.push(l) })
    expect(code).toBe(0)
    expect(errs.join('\n')).toMatch(/config-history/)
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).trust_mode).toBe(true)
  })
})
