import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { reservePort } from '../e2e/harness/port.ts'

const listenOn = (port: number) =>
  new Promise<() => Promise<void>>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => resolve(() => new Promise<void>((r) => s.close(() => r()))))
  })

describe('the e2e stack holds its relay port until the relay listens (fb7426b: 12c failed with listen EADDRINUSE)', () => {
  test('a reserved port cannot be taken by another listener until it is released, then it can', async () => {
    const r = await reservePort()
    await expect(listenOn(r.port)).rejects.toMatchObject({ code: 'EADDRINUSE' })
    await r.release()
    await r.release() // twice is harmless
    const close = await listenOn(r.port)
    await close()
  })

  test('startStack reserves the port (never freePort) and releases it only right before the relay boots', () => {
    const src = readFileSync(join(import.meta.dirname, '../e2e/harness/stack.ts'), 'utf8')
    const body = src.slice(src.indexOf('export async function startStack'))
    const fn = body.slice(0, body.indexOf('\n}\n'))
    expect(fn).not.toMatch(/\bfreePort\(\)/)
    expect(fn).toMatch(/= await reservePort\(\)/)
    // the release that matters sits on the line right before the first boot, after the slow `talos-app init`
    const lines = fn.split('\n')
    const boot = lines.findIndex((l) => /^\s*let relay = await boot\(\)/.test(l))
    expect(boot).toBeGreaterThan(0)
    expect(lines[boot - 1]).toMatch(/^\s*await reserved\.release\(\)/)
    const init = lines.findIndex((l) => /spawnSync\('bun', \['run', BRIDGE_CLI, 'init'/.test(l))
    const reserve = lines.findIndex((l) => /= await reservePort\(\)/.test(l))
    expect(reserve).toBeGreaterThan(0)
    expect(reserve).toBeLessThan(init)
  })
})
