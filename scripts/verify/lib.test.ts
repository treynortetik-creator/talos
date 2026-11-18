// The verify harness's pure parts (scripts/verify/lib.mjs, bridge-run.mjs): evidence names, the index, WCAG contrast, the font
// identity check, the theme list read from code, the group-limit runner, and the clean environment for the bridge route.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanEnv, parseStep } from './bridge-run.mjs'
import {
  addCapture,
  captureName,
  contrastRatio,
  evidenceRoot,
  fontDifferences,
  judgeContrast,
  listThemes,
  loadIndex,
  parseArgs,
  parseColour,
  renderIndex,
  runGroup,
  saveIndex,
  Unreachable,
  Usage,
} from './lib.mjs'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'verify-lib-'))
  dirs.push(d)
  return d
}
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('evidence names and the root', () => {
  it('names a capture <surface>-<route>-<theme>-<before|after>.<ext>', () => {
    expect(captureName({ surface: 'web-desktop', route: 'wordmark', theme: 'paper', label: 'after', ext: 'png' })).toBe(
      'web-desktop-wordmark-paper-after.png',
    )
  })
  it('refuses a name that could leave the folder, an unknown label and an unknown extension', () => {
    const ok = { surface: 'web', route: 'home', theme: 'talos', label: 'after', ext: 'png' }
    expect(() => captureName({ ...ok, route: '../x' })).toThrow(Usage)
    expect(() => captureName({ ...ok, theme: 'Paper' })).toThrow(Usage)
    expect(() => captureName({ ...ok, label: 'later' })).toThrow(Usage)
    expect(() => captureName({ ...ok, ext: 'sh' })).toThrow(Usage)
  })
  it('the root is overridable by TALOS_VERIFY_EVIDENCE_ROOT', () => {
    expect(evidenceRoot({ TALOS_VERIFY_EVIDENCE_ROOT: '/x/y' })).toBe('/x/y')
    expect(evidenceRoot({})).toMatch(/talos-verify-evidence$/)
  })
})

describe('arguments', () => {
  it('reads --a b, --a=b, repeatable flags and booleans', () => {
    const a = parseArgs(['web', '--label', 'after', '--cli=x', '--cli', 'y', '--no-contrast'], {
      repeatable: ['cli'],
      booleans: ['no-contrast'],
    })
    expect(a).toMatchObject({ _: ['web'], label: 'after', cli: ['x', 'y'], 'no-contrast': true })
  })
  it('a flag with no value is a usage error, not undefined', () => {
    expect(() => parseArgs(['--label'])).toThrow(Usage)
  })
  it('a bridge step may carry the exit code it must have', () => {
    expect(parseStep('2::errors list')).toEqual({ exit: 2, text: 'errors list' })
    expect(parseStep('errors list')).toEqual({ exit: 0, text: 'errors list' })
  })
})

describe('contrast (WCAG 2.x)', () => {
  it('black on white is 21:1 and white on white 1:1', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5)
  })
  it('reads rgb, rgba and hex; anything else is null, and null is a FAIL, never a pass', () => {
    expect(parseColour('rgb(10, 20, 30)')).toEqual([10, 20, 30, 1])
    expect(parseColour('rgba(10, 20, 30, 0.5)')).toEqual([10, 20, 30, 0.5])
    expect(parseColour('#0a141e')).toEqual([10, 20, 30, 1])
    expect(parseColour('oklch(0.5 0.1 200)')).toBeNull()
    expect(judgeContrast({ label: 'x', fg: 'oklch(0.5 0.1 200)', bg: '#ffffff', px: 16, weight: '400' }).ok).toBe(false)
  })
  it('body text needs 4.5; large text needs 3', () => {
    const grey = 'rgb(130, 130, 130)' // about 3.5:1 on white
    expect(judgeContrast({ label: 'body', fg: grey, bg: '#ffffff', px: 16, weight: '400' })).toMatchObject({
      ok: false,
      need: 4.5,
    })
    expect(judgeContrast({ label: 'big', fg: grey, bg: '#ffffff', px: 24, weight: '400' })).toMatchObject({
      ok: true,
      need: 3,
    })
    expect(judgeContrast({ label: 'bold', fg: grey, bg: '#ffffff', px: 19, weight: '700' })).toMatchObject({
      ok: true,
      need: 3,
    })
  })
  it('a translucent text colour is laid over its background first', () => {
    expect(judgeContrast({ label: 'x', fg: 'rgba(0, 0, 0, 0.1)', bg: '#ffffff', px: 16, weight: '400' }).ok).toBe(false)
  })
})

describe('fonts must be identical in every theme', () => {
  const same = { body: 'Inter | weight 400', wordmark: 'Cinzel | weight 900' }
  it('identical everywhere is no finding', () => {
    expect(fontDifferences({ talos: same, paper: same, hearth: same })).toEqual([])
  })
  it("one theme with another font is a finding that names the target and every theme's value", () => {
    const f = fontDifferences({ talos: same, paper: same, hearth: { ...same, body: 'Georgia | weight 400' } })
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({
      target: 'body',
      values: { talos: 'Inter | weight 400', hearth: 'Georgia | weight 400' },
    })
  })
  it('an element present in only one theme is a finding too (missing is not "same")', () => {
    expect(fontDifferences({ talos: same, paper: { body: same.body } })[0]).toMatchObject({ target: 'wordmark' })
  })
})

describe("the theme list comes from the checkout's own code", () => {
  it('reads STOCK_THEME_IDS from packages/protocol/src/theme.ts, so a new theme is picked up with no edit here', async () => {
    const w = tmp()
    mkdirSync(join(w, 'packages/protocol/src'), { recursive: true })
    writeFileSync(
      join(w, 'packages/protocol/src/theme.ts'),
      "export const STOCK_THEME_IDS = ['talos', 'paper', 'hearth', 'dusk'] as const\n",
    )
    expect(await listThemes(w)).toEqual(['talos', 'paper', 'hearth', 'dusk'])
  })
  it('a checkout without the list is an unreachable surface (exit 3), never a silent default', async () => {
    const w = tmp()
    await expect(listThemes(w)).rejects.toThrow(Unreachable)
    mkdirSync(join(w, 'packages/protocol/src'), { recursive: true })
    writeFileSync(join(w, 'packages/protocol/src/theme.ts'), 'export const OTHER = 1\n')
    await expect(listThemes(w)).rejects.toThrow(/STOCK_THEME_IDS/)
  })
  it("lists the real repo's themes (at least the three named examples)", async () => {
    const ids = await listThemes(join(__dirname, '../..'))
    for (const t of ['talos', 'paper', 'hearth']) expect(ids).toContain(t)
  })
})

describe('the index', () => {
  const rec = (file: string, extra = {}) => ({
    file,
    surface: 'web-desktop',
    route: 'home',
    theme: 'talos',
    label: 'before',
    tree: 'abc',
    result: 'ok',
    proves: 'a | b',
    ...extra,
  })
  it('a re-run replaces the same file instead of listing it twice, and a "|" cannot break the table', () => {
    const d = tmp()
    const idx = loadIndex(d)
    addCapture(idx, rec('a.png'))
    addCapture(idx, rec('a.png', { result: 'FAIL: x' }))
    saveIndex(d, idx)
    const md = readFileSync(join(d, 'index.md'), 'utf8')
    expect(md.match(/a\.png/g)).toHaveLength(1)
    expect(md).toContain('FAIL: x')
    expect(md).toContain('a \\| b')
    expect(loadIndex(d).captures).toHaveLength(1)
  })
  it('before and after runs add to one list, with the route list on top', () => {
    const d = tmp()
    const idx = loadIndex(d)
    idx.routeList = '- own device: exercised\n- beta install: NOT exercised (no second device)'
    addCapture(idx, rec('a-before.png'))
    addCapture(idx, rec('a-after.png', { label: 'after' }))
    const md = renderIndex(idx)
    expect(md.indexOf('NOT exercised')).toBeLessThan(md.indexOf('a-before.png'))
    expect(md).toContain('a-after.png')
  })
  it('an index with no route list says so loudly', () => {
    expect(renderIndex({ title: '', routeList: '', captures: [] })).toContain('(none written')
  })
  it('nothing is written until saveIndex', () => {
    const d = join(tmp(), 'x')
    loadIndex(d)
    expect(existsSync(d)).toBe(false)
  })
})

describe('runGroup: the limit stops the whole group', () => {
  it('passes exit codes and output through', async () => {
    const r = await runGroup('sh', ['-c', 'echo out; echo err >&2; exit 7'], { timeoutMs: 10_000 })
    expect(r).toMatchObject({ code: 7, timedOut: false, stdout: 'out\n', stderr: 'err\n' })
  })
  it('at the limit a child that ignores nothing AND its own child are both gone', async () => {
    const d = tmp()
    const pidFile = join(d, 'child.pid')
    const r = await runGroup('sh', ['-c', `sleep 60 & echo $! > ${pidFile}; wait`], { timeoutMs: 800 })
    expect(r.timedOut).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await new Promise((res) => setTimeout(res, 300))
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })
  it('a command that does not exist is exit 127 with the reason, not a throw', async () => {
    const r = await runGroup('definitely-not-a-command-xyz', [], { timeoutMs: 5000 })
    expect(r.code).toBe(127)
  })
})

describe("the bridge route's environment", () => {
  it('drops every TALOS_*, CLAUDE_CODE_*, CLAUDECODE and CHRONOS_RUN, points the home at the throwaway folder, keeps PATH', () => {
    const e = cleanEnv(
      {
        PATH: '/bin',
        HOME: '/home/alex',
        TALOS_APP_HOME: '/home/alex/.talos',
        TALOS_SESSION_ROLE: 'x',
        CLAUDE_CODE_FOO: '1',
        CLAUDECODE: '1',
        CHRONOS_RUN: '1',
        KEEP: 'y',
      },
      '/tmp/h',
      '/tmp/f',
    )
    expect(e).toEqual({ PATH: '/bin', KEEP: 'y', TALOS_APP_HOME: '/tmp/h', HOME: '/tmp/f' })
  })
})
