// `talos-app enroll --json` (src/enroll-cli.ts): the events a program (the Windows tray) reads, in order, and the one
// answer line it may write. The four words come from the live bridge's record; only exactly "y" pins.
import { afterEach, describe, expect, test } from 'bun:test'
import { bindingMac, createDeviceKey, deriveEnrollBind, fingerprintWords } from '@talos-app/protocol'
import { runCli } from '../src/cli.ts'
import { paths } from '../src/config.ts'
import { EnrollFiles } from '../src/enroll-files.ts'
import { type Harness, startHarness, waitFor } from './helpers.ts'

let h: Harness
afterEach(async () => h?.stop())

type Ev = Record<string, unknown> & { event: string }
function jsonCli(answer: string) {
  const events: Ev[] = []
  const out: string[] = []
  const err: string[] = []
  const prompts: string[] = []
  let now = Date.now()
  return {
    events,
    out,
    err,
    prompts,
    later: (ms: number) => {
      now += ms
    },
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      // the fake relay has no descriptor, so every run gets the old_relay warning; enroll-fp.test.ts holds that one
      emit: (l: string) => {
        const e = JSON.parse(l) as Ev
        if (!(e.event === 'warning' && e.code === 'old_relay')) events.push(e)
      },
      prompt: async (q: string) => {
        prompts.push(q)
        now += 600 // a person reads the words first (an answer under 500 ms is typed ahead, a no)
        return answer
      },
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20))),
      now: () => now,
    },
  }
}
const env = (hh: Harness) => ({ TALOS_APP_HOME: hh.home, TALOS_APP_RELAY_URL: hh.relay.httpUrl })

/** Starts `enroll --json`, waits for its link, and has a device enroll with it. */
async function enrollWith(c: ReturnType<typeof jsonCli>, name = 'iPhone') {
  const done = runCli(['enroll', '--json', '--label', 'phone'], c.io, env(h))
  await waitFor(() => c.events.some((e) => e.event === 'link'), 3000, 'the link event')
  const link = c.events.find((e) => e.event === 'link')?.link as string
  const code = link.split('#')[1] as string
  const files = new EnrollFiles(paths(h.home).enrollPending)
  const codeId = files.codeIds()[0] as string
  const dev = await createDeviceKey()
  h.relay.sendToBridge({
    type: 'device.enrolled',
    device: { id: dev.deviceId, name, pubkey_jwk: dev.publicJwk },
    binding: bindingMac(deriveEnrollBind(code), dev.deviceId, dev.publicJwk),
    code_id: codeId,
    credential_id: 'cred-1',
  })
  return { done, dev, files, codeId }
}

describe('enroll --json', () => {
  test('link, then the four words from the bridge, then "y" pins: answered, pinned, exit 0, and nothing else on stdout', async () => {
    h = await startHarness()
    const c = jsonCli('y')
    const { done, dev } = await enrollWith(c)
    await waitFor(() => c.events.some((e) => e.event === 'answered'), 3000, 'the answer')
    await h.bridge.enrollment.poll()
    expect(await done).toBe(0)
    expect(c.events.map((e) => e.event)).toEqual(['link', 'confirm', 'answered', 'pinned'])
    const [link, confirm, answered, pinned] = c.events
    expect(link?.link).toMatch(/\/enroll#/)
    expect(typeof link?.expires_at).toBe('string')
    expect(confirm).toEqual({ event: 'confirm', device_name: 'iPhone', words: [...fingerprintWords(dev.deviceId)] })
    expect(answered).toEqual({ event: 'answered', yes: true })
    expect(pinned).toEqual({ event: 'pinned', device_id: dev.deviceId })
    expect(c.out).toEqual([]) // stdout is only the events
    expect(c.prompts).toEqual(['']) // the question is the confirm event, not prompt text
    expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId)).toEqual(dev.publicJwk)
  })

  for (const answer of ['n', '', 'yes', 'Y', ' y', 'y y', '{"yes":true}']) {
    test(`the answer ${JSON.stringify(answer)} is a no: nothing is pinned, exit 0`, async () => {
      h = await startHarness()
      const c = jsonCli(answer)
      const { done, dev, files, codeId } = await enrollWith(c)
      expect(await done).toBe(0)
      expect(c.events.map((e) => e.event)).toEqual(['link', 'confirm', 'answered'])
      expect(c.events[2]).toEqual({ event: 'answered', yes: false })
      expect(files.readAnswer(codeId)?.yes).toBe(false)
      await h.bridge.enrollment.poll()
      expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId)).toBeUndefined()
    })
  }

  test('the words shown are the ones the device id gives, whatever the confirm file says', async () => {
    h = await startHarness()
    const c = jsonCli('n')
    const done = runCli(['enroll', '--json'], c.io, env(h))
    await waitFor(() => c.events.some((e) => e.event === 'link'), 3000, 'the link event')
    const files = new EnrollFiles(paths(h.home).enrollPending)
    const codeId = files.codeIds()[0] as string
    const dev = await createDeviceKey()
    files.writeConfirm(codeId, {
      device_id: dev.deviceId,
      name: 'x',
      fingerprint: ['<b>bold</b>', 'two', 'three', 'four'],
    } as never)
    expect(await done).toBe(0)
    expect(c.events.find((e) => e.event === 'confirm')?.words).toEqual([...fingerprintWords(dev.deviceId)])
  })

  test('a device whose words hold Yucat\u00e1n gets its confirm, not bad_words (about 2 devices in 256 could not pair)', async () => {
    h = await startHarness()
    const c = jsonCli('n')
    const done = runCli(['enroll', '--json'], c.io, env(h))
    await waitFor(() => c.events.some((e) => e.event === 'link'), 3000, 'the link event')
    const files = new EnrollFiles(paths(h.home).enrollPending)
    const codeId = files.codeIds()[0] as string
    files.writeConfirm(codeId, { device_id: `d_ad7q${'a'.repeat(16)}`, name: 'x' } as never) // bytes 00 ff 00 00
    expect(await done).toBe(0)
    expect((c.events.find((e) => e.event === 'confirm')?.words as string[] | undefined)?.[1]).toBe('Yucat\u00e1n')
    expect(c.events.some((e) => e.event === 'error')).toBe(false)
    expect(c.events.at(-1)).toMatchObject({ event: 'answered', yes: false })
  })

  test('an answer typed ahead (under 500 ms after the question) is a no', async () => {
    h = await startHarness()
    const c = jsonCli('y')
    c.io.prompt = async (q: string) => {
      c.prompts.push(q)
      return 'y' // at once: it was waiting in stdin before the words were shown
    }
    const { done, dev, files, codeId } = await enrollWith(c)
    expect(await done).toBe(0)
    expect(c.events.at(-1)).toEqual({ event: 'answered', yes: false })
    expect(files.readAnswer(codeId)?.yes).toBe(false)
    await h.bridge.enrollment.poll()
    expect(h.bridge.ctx.devices.pinnedKey(dev.deviceId)).toBeUndefined()
  })

  test('a question withdrawn while it is asked (another device used the code) ends with used and writes no answer', async () => {
    h = await startHarness()
    const c = jsonCli('y')
    let files: EnrollFiles | undefined
    let codeId = ''
    const ask = c.io.prompt
    c.io.prompt = async (q: string) => {
      files?.removeAll(codeId) // what the bridge does when a second device enrolls with the same code
      return ask(q)
    }
    const r = await enrollWith(c)
    files = r.files
    codeId = r.codeId
    expect(await r.done).toBe(1)
    expect(c.events.at(-1)).toEqual({ event: 'used' })
    expect(r.files.readAnswer(r.codeId)).toBeUndefined()
  })

  test('no live bridge: a warning first, then the link; ten minutes with no device: expired, exit 1', async () => {
    h = await startHarness({ startBridge: false })
    const c = jsonCli('y')
    const done = runCli(['enroll', '--json'], c.io, env(h))
    await waitFor(() => c.events.some((e) => e.event === 'link'), 3000, 'the link event')
    c.later(11 * 60_000)
    expect(await done).toBe(1)
    expect(c.events.map((e) => e.event)).toEqual(['warning', 'link', 'expired'])
    expect(c.events[0]).toMatchObject({ code: 'bridge_not_live' })
  })

  test('--json with --confirm is a usage error event; and --json stays terminal-only', async () => {
    h = await startHarness({ startBridge: false })
    const c = jsonCli('y')
    expect(await runCli(['enroll', '--json', '--confirm'], c.io, env(h))).toBe(1)
    expect(c.events).toEqual([{ event: 'error', code: 'usage', text: '--json does not go with --confirm' }])
    const piped = jsonCli('y')
    expect(await runCli(['enroll', '--json'], { ...piped.io, isTerminal: false }, env(h))).toBe(1)
    expect(piped.events).toEqual([])
    expect(piped.err.join('\n')).toContain('only runs in Terminal')
  })

  test('a parse error with --json=x is an event, not text', async () => {
    h = await startHarness({ startBridge: false })
    const c = jsonCli('y')
    expect(await runCli(['enroll', '--json=x'], c.io, env(h))).toBe(1)
    expect(c.events[0]).toMatchObject({ event: 'error', code: 'usage' })
  })

  test('anything that throws while the question is open ends with an error event and answers it no', async () => {
    h = await startHarness()
    const c = jsonCli('y')
    c.io.prompt = async () => {
      throw new Error('stdin gone')
    }
    const r = await enrollWith(c)
    expect(await r.done).toBe(1)
    expect(c.events.map((e) => e.event)).toEqual(['link', 'confirm', 'error'])
    expect(c.events.at(-1)).toMatchObject({ code: 'internal', text: 'stdin gone' })
    expect(r.files.readAnswer(r.codeId)?.yes).toBe(false)
    await h.bridge.enrollment.poll()
    expect(h.bridge.ctx.devices.pinnedKey(r.dev.deviceId)).toBeUndefined()
  })

  test('writeStdout writes the whole line to a real descriptor', async () => {
    const { mkdtempSync, openSync, readFileSync, closeSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { writeStdout } = await import('../src/enroll-cli.ts')
    const f = join(mkdtempSync(join(tmpdir(), 'ej-')), 'out')
    const fd = openSync(f, 'w')
    writeStdout(JSON.stringify({ event: 'link', link: 'x'.repeat(70_000) }), fd)
    closeSync(fd)
    const text = readFileSync(f, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text).link).toHaveLength(70_000)
  })
})

describe('enroll --json: the four words', () => {
  // A device whose words include "Yucat\u00e1n" (PGP_ODD_WORDS[255], a byte 0xff at an odd place: about 2 devices in 256)
  // was refused as bad_words, so its pairing failed. Now the words must be the list's own, each from its list by position.
  test('every PGP word passes in its place, Yucat\u00e1n included; anything else, a real word in the wrong place too, does not', async () => {
    const { plainWords } = await import('../src/enroll-cli.ts')
    const { fingerprintWords, PGP_EVEN_WORDS, PGP_ODD_WORDS } = await import('@talos-app/protocol')
    for (let i = 0; i < 256; i++) {
      const w = [PGP_EVEN_WORDS[i], PGP_ODD_WORDS[i], PGP_EVEN_WORDS[i], PGP_ODD_WORDS[i]] as string[]
      expect(plainWords(w), w.join(' ')).toBe(true)
    }
    const words = fingerprintWords(`d_ad7q${'a'.repeat(16)}`) // bytes 00 ff 00 00: Yucat\u00e1n second
    expect(words[1]).toBe('Yucat\u00e1n')
    expect(plainWords(words)).toBe(true)
    const [e, o] = [PGP_EVEN_WORDS[0] as string, PGP_ODD_WORDS[0] as string]
    for (const bad of [
      [e, o, e], // three
      [o, e, o, e], // real words, wrong places
      [e, 'Yucata\u0301n', e, o], // decomposed
      [e, `${o}\u200f`, e, o], // a direction mark
      [e, o, e, 'x\u3164'], // an invisible letter
      [e, o, e, 'a'.repeat(25)],
      [e, o, e, 'd_e'],
      [e.toUpperCase(), o, e, o], // not the list's own form
    ])
      expect(plainWords(bad), JSON.stringify(bad)).toBe(false)
  })
})
