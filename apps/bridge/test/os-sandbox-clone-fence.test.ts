// R1256 (docs/FOLLOWUPS.md R3-1): a thread folder that holds the Talos code folder (the clone), or sits inside it, is refused, and the
// clone's bridge folder and the pinned bun are never writable from a session, whatever the folder. Real temp folders only.
import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { hookCommand } from '../src/guards/install.ts'
import { osSandboxSettings, prepareOsSandbox } from '../src/guards/os-sandbox.ts'
import { cloneFenceProblem, foldName, trustedBridge } from '../src/guards/os-sandbox-folder.ts'
import { ourHook } from '../src/guards/refresh.ts'
import { mcpEntry, mcpEntryState } from '../src/mcp-config.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), p)))
  dirs.push(d)
  return d
}
const put = (p: string, text = '') => {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
/** A home, a user home, and a clone with a bun beside it, all by real path. */
function world() {
  const home = tmp('cf-home-')
  put(join(home, 'config.json'), '{}')
  const userHome = tmp('cf-user-')
  const root = tmp('cf-root-')
  const clone = join(root, 'talos-clone')
  mkdirSync(join(clone, 'apps', 'bridge', 'src'), { recursive: true })
  const bun = join(root, 'tools', 'bun')
  put(bun, '#!/bin/sh\n')
  const trusted = { bun, bridgeDir: join(clone, 'apps', 'bridge') }
  const start = (folder: string, over: { loadsProject?: boolean } = {}) =>
    prepareOsSandbox(
      { talosHome: home, userHome, claudeDir: join(userHome, '.claude'), folder, trusted, ...over },
      { ownerExcludes: () => [], write: () => {} },
    )
  return { home, userHome, root, clone, bun, trusted, start }
}
const refusal = (r: ReturnType<ReturnType<typeof world>['start']>) => ('refusal' in r ? r.refusal : null)
const CLONE_LINE = 'This folder contains the Talos code, or is inside it. Pick another folder and start again.'
const BUN_LINE = 'This folder contains the program Talos runs on, or is inside it. Pick another folder and start again.'
const WORDS = new RegExp(`^(${CLONE_LINE}|${BUN_LINE})$`.replaceAll('.', '\\.'))

describe('a folder that holds the clone, or is inside it, is refused', () => {
  test('a folder that contains the clone', () => {
    const w = world()
    expect(refusal(w.start(w.root))).toMatch(WORDS)
  })
  test('a folder inside the clone, and the bridge folder itself', () => {
    const w = world()
    mkdirSync(join(w.clone, 'docs'), { recursive: true })
    expect(refusal(w.start(join(w.clone, 'docs')))).toMatch(WORDS)
    expect(refusal(w.start(w.clone))).toMatch(WORDS)
    expect(refusal(w.start(w.trusted.bridgeDir))).toMatch(WORDS)
  })
  test('a thread that loads no project settings is refused the same way', () => {
    const w = world()
    expect(refusal(w.start(w.root, { loadsProject: false }))).toMatch(WORDS)
    expect(refusal(w.start(join(w.clone, 'apps'), { loadsProject: false }))).toMatch(WORDS)
  })
  test('a folder reached through a link to the clone, or to the clone parent, is refused', () => {
    const w = world()
    const other = tmp('cf-links-')
    symlinkSync(w.clone, join(other, 'to-clone'))
    symlinkSync(w.root, join(other, 'to-parent'))
    symlinkSync(join(w.clone, 'apps'), join(other, 'to-apps'))
    for (const l of ['to-clone', 'to-parent', 'to-apps']) expect(refusal(w.start(join(other, l))), l).toMatch(WORDS)
  })
  test('the recorded clone spelled through a link still counts', () => {
    const w = world()
    const other = tmp('cf-links-')
    symlinkSync(w.clone, join(other, 'alias'))
    const trusted = { bun: w.bun, bridgeDir: join(other, 'alias', 'apps', 'bridge') }
    const r = prepareOsSandbox(
      { talosHome: w.home, userHome: w.userHome, claudeDir: join(w.userHome, '.claude'), folder: w.root, trusted },
      { ownerExcludes: () => [], write: () => {} },
    )
    expect(refusal(r)).toMatch(WORDS)
  })
  // skip: Mac only, a Mac's default disk ignores letter case and other systems' don't
  test.skipIf(process.platform !== 'darwin')('a different letter case of the clone path is refused on a Mac', () => {
    const w = world()
    expect(refusal(w.start(w.clone.toUpperCase()))).not.toBeNull()
  })
  test('a folder that holds the pinned bun is refused', () => {
    const w = world()
    expect(refusal(w.start(join(w.root, 'tools')))).toMatch(WORDS)
  })
  test('a folder beside the clone and the bun is not refused', () => {
    const w = world()
    const side = tmp('cf-side-')
    expect(refusal(w.start(side))).toBeNull()
  })
  test('a start with no record is not refused for this', () => {
    const w = world()
    const r = prepareOsSandbox(
      {
        talosHome: w.home,
        userHome: w.userHome,
        claudeDir: join(w.userHome, '.claude'),
        folder: w.root,
        trusted: null,
      },
      { ownerExcludes: () => [], write: () => {} },
    )
    expect(refusal(r)).toBeNull()
  })
})

describe('the clone bridge folder and bun are always unwritable', () => {
  const deny = (w: ReturnType<typeof world>, folder: string, platform: NodeJS.Platform = 'linux') =>
    osSandboxSettings({ talosHome: w.home, userHome: w.userHome, folder, platform, trusted: w.trusted }).sandbox
      .filesystem.denyWrite
  test('for a folder elsewhere', () => {
    const w = world()
    const d = deny(w, tmp('cf-side-'))
    expect(d).toContain(w.trusted.bridgeDir)
    expect(d).toContain(w.bun)
  })
  test('even for a folder inside the clone or holding it (the builder alone)', () => {
    const w = world()
    for (const f of [join(w.clone, 'apps'), w.root, w.clone]) {
      const d = deny(w, f)
      expect(d, f).toContain(w.trusted.bridgeDir)
      expect(d, f).toContain(w.bun)
    }
  })
  test('on a Mac the lower-case spellings are there too', () => {
    const w = world()
    const d = deny(w, tmp('cf-side-'), 'darwin')
    expect(d).toContain(w.trusted.bridgeDir.toLowerCase())
    expect(d).toContain(w.bun.toLowerCase())
  })
  test('bun by its real path when the record names a link', () => {
    const w = world()
    const alias = join(w.root, 'bun-alias')
    symlinkSync(w.bun, alias)
    const d = osSandboxSettings({
      talosHome: w.home,
      userHome: w.userHome,
      folder: tmp('cf-side-'),
      platform: 'linux',
      trusted: { bun: alias, bridgeDir: w.trusted.bridgeDir },
    }).sandbox.filesystem.denyWrite
    expect(d).toContain(w.bun)
  })
})

describe('review fixes', () => {
  test('a folder of / is refused (the root holds everything)', () => {
    const w = world()
    expect(cloneFenceProblem('/', w.trusted)).toBe(CLONE_LINE)
  })
  test('the refusal lines are the ones Pantheon wrote', () => {
    const w = world()
    expect(refusal(w.start(w.root))).toBe(CLONE_LINE)
    expect(refusal(w.start(join(w.root, 'tools')))).toBe(BUN_LINE)
  })
  test('the guard hook command turns the bun compile cache off and refresh still reads it', () => {
    const cmd = hookCommand('/opt/b/bun', '/opt/c', '/opt/g.json', 'a'.repeat(64))
    expect(cmd).toContain('BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 exec "/opt/b/bun"')
    const h = ourHook({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: cmd }] }] } })
    expect(h?.bun).toBe('/opt/b/bun')
  })
  test('the talos-app entry carries the cache switch, is still current, and starts; another value refuses', () => {
    const w = world()
    const folder = tmp('cf-agent-')
    const e = mcpEntry(w.trusted.bridgeDir, w.home, folder, w.bun)
    expect(e.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH).toBe('0')
    expect(mcpEntryState(e, w.trusted.bridgeDir)).toBe('current')
    const run = (env: Record<string, string>) => {
      put(join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { 'talos-app': { ...e, env } } }))
      return refusal(w.start(folder))
    }
    expect(run(e.env)).toBeNull()
    expect(run({ ...e.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '1' })).toMatch(/not Talos's own/)
    const { BUN_RUNTIME_TRANSPILER_CACHE_PATH: _gone, ...without } = e.env
    expect(run(without)).toBeNull() // optional: an entry written before this change still starts
  })
  test('the Mac name fold applies NFC before lower case, and only on a Mac', () => {
    expect(foldName('/Café/X', 'darwin')).toBe('/café/x')
    expect(foldName('/Café/X', 'linux')).toBe('/Café/X')
  })
  describe('two buns, and a bun in a temp folder (the temp roots are passed in: they do not depend on this machine)', () => {
    const withPath = (dir: string) => {
      const was = process.env.PATH
      process.env.PATH = `${dir}:${was}`
      return () => {
        process.env.PATH = was
      }
    }
    const fakeBun = (dir: string) => {
      const p = join(dir, 'bun')
      put(p, '#!/bin/sh\n')
      chmodSync(p, 0o755)
      return realpathSync(p)
    }
    const real = realpathSync(process.execPath)
    const denyOf = (w: ReturnType<typeof world>, t: ReturnType<typeof trustedBridge>) =>
      osSandboxSettings({
        talosHome: w.home,
        userHome: w.userHome,
        folder: tmp('cf-side-'),
        platform: 'linux',
        trusted: t,
      }).sandbox.filesystem.denyWrite
    const withFake = (f: (dir: string, fake: string) => void) => {
      const dir = tmp('cf-pathbun-')
      const undo = withPath(dir)
      try {
        f(dir, fakeBun(dir))
      } finally {
        undo()
      }
    }
    test('the PATH bun and the running bun are both fenced and denied when they differ', () => {
      const w = world()
      withFake((dir, fake) => {
        const t = trustedBridge([])
        const all = [t?.bun, ...(t?.extraBuns ?? [])]
        expect(all).toContain(fake)
        expect(all).toContain(real)
        for (const b of all) expect(denyOf(w, t)).toContain(b as string)
        expect(cloneFenceProblem(dir, t)).toBe(BUN_LINE)
        expect(cloneFenceProblem(dirname(real), t)).toBe(BUN_LINE)
      })
    })
    test('a running bun in a temp folder is dropped from the extra buns; the record and the clone denies stay', () => {
      const w = world()
      withFake((_dir, fake) => {
        const t = trustedBridge([dirname(real)])
        expect(t?.bun).toBe(fake)
        expect(t?.extraBuns ?? []).not.toContain(real)
        expect(denyOf(w, t)).toContain(realpathSync(join(t?.bridgeDir as string, '..', '..')))
      })
    })
    test('the PATH bun in a temp folder keeps the record and its denies; a talos-app server is refused in plain words, a folder without one starts', () => {
      const w = world()
      withFake((dir, fake) => {
        const t = trustedBridge([dir])
        expect(t).not.toBeNull()
        expect(t?.bun).toBe(fake)
        expect(t?.bunInTemp).toBe(true)
        expect(t?.extraBuns).toContain(real)
        const d = denyOf(w, t)
        expect(d).toContain(realpathSync(join(t?.bridgeDir as string, '..', '..')))
        expect(d).toContain(fake)
        const rec = { ...(t as NonNullable<typeof t>), bridgeDir: w.trusted.bridgeDir }
        const go = (folder: string) =>
          refusal(
            prepareOsSandbox(
              { talosHome: w.home, userHome: w.userHome, claudeDir: join(w.userHome, '.claude'), folder, trusted: rec },
              { ownerExcludes: () => [], write: () => {} },
            ),
          )
        const withServer = tmp('cf-agent-')
        put(
          join(withServer, '.mcp.json'),
          JSON.stringify({ mcpServers: { 'talos-app': mcpEntry(rec.bridgeDir, w.home, withServer, fake) } }),
        )
        expect(go(withServer)).toBe(
          `${withServer}/.mcp.json has a talos-app server that is not Talos's own (its bun is in a shared temp folder); run talos-app adopt for this folder, then start again`,
        )
        expect(go(tmp('cf-agent-'))).toBeNull()
      })
    })
    test('a clone in a temp folder gives no record', () => {
      withFake(() => {
        expect(trustedBridge([realpathSync(join(import.meta.dir, '..', '..'))])).toBeNull()
      })
    })
  })
})

test('refresh still reads a guard hook written before the cache switch (and can then rewrite it)', () => {
  const cmd = hookCommand('/opt/b/bun', '/opt/c', '/opt/g.json', 'a'.repeat(64)).replace(
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 ',
    '',
  )
  expect(cmd).not.toContain('BUN_RUNTIME')
  const h = ourHook({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: cmd }] }] } })
  expect(h?.bun).toBe('/opt/b/bun')
})
