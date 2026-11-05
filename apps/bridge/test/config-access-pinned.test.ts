// Pins what ConfigFile.applyPatch does with each kind of field today: the phone may change the listed ones, may only turn
// the memory browser off, and writes trust_mode (a boolean) only when the patch names it. Written by hand, not read from the
// settings table.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigFile } from '../src/config-file.ts'

const defaults = JSON.parse(readFileSync(join(import.meta.dir, '../../../examples/config.default.json'), 'utf8'))

let dir: string
let file: ConfigFile
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'talos-config-pin-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify(defaults))
  file = new ConfigFile(join(dir, 'config.json'))
  file.load()
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ConfigFile.applyPatch: who may change what', () => {
  test.each([
    [{ agent: { name: 'Atlas' } }],
    [{ agent: { voice_persona: 'calm' } }],
    [{ owner: { display_name: 'Alex Example' } }],
    [{ timezone: 'Europe/Paris' }],
    [{ quiet_window: { start: '22:00', end: '07:00' } }],
    [{ notifications: { master: false } }],
    [{ voice_notes: { reply_with_voice: 'always' } }],
    [{ work: { label: 'Work' } }],
    [{ work: { retention: 'buffer' } }],
    [{ permission_relay: true }],
    [{ session_models: ['default', 'opus'] }],
    [{ memory_browser: false }],
    [{ trust_mode: true }],
    [{ trust_mode: false }],
  ])('%j is applied', (patch) => {
    const r = file.applyPatch(0, patch as Record<string, unknown>)
    expect(r.ok).toBe(true)
  })

  test.each([
    [{ mirror: { telegram: 'on' } }, 'field not allowed: mirror'],
    [{ trust_mode: 'yes' }, 'field not allowed: trust_mode'],
    [{ version: 2 }, 'field not allowed: version'],
    [{ rev: 9 }, 'field not allowed: rev'],
    [{ work: { surprise: 1 } }, 'field not allowed: work.surprise'],
    [{ surprise: 1 }, 'field not allowed: surprise'],
  ])('%j is refused as config_field_forbidden', (patch, message) => {
    expect(file.applyPatch(0, patch as Record<string, unknown>)).toEqual({
      ok: false,
      code: 'config_field_forbidden',
      message,
    })
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).rev).toBe(0)
  })

  test.each([[true], ['on'], [null], [1]])('the phone cannot set memory_browser to %j', (value) => {
    expect(file.applyPatch(0, { memory_browser: value })).toEqual({
      ok: false,
      code: 'config_field_forbidden',
      message: 'the memory browser can only be turned on at your Mac (talos-app memory on)',
    })
  })

  test('the phone can turn the memory browser off', () => {
    const r = file.applyPatch(0, { memory_browser: false })
    expect(r.ok && r.config.memory_browser).toBe(false)
  })

  test('a trust_mode the Mac set stays set through a phone patch', () => {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaults, trust_mode: true }))
    file.load()
    const r = file.applyPatch(0, { agent: { name: 'Atlas' } })
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).trust_mode).toBe(true)
  })
})
