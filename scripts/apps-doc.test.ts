// Guards the shipped MCP Apps docs: no private references, the headings and terms an owner needs, closed code fences, real
// file paths, and a troubleshooting table whose codes are the real AppErrorCode members.
//
// Forbidden strings are assembled at run time so this file itself stays clean under the personal-data scan.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// Relative on purpose: the scripts project has no workspace link to @talos-app/protocol; this is the package's own entry.
import { AppErrorCode } from '../packages/protocol/src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const j = (...p: string[]) => p.join('')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const APPS = 'docs/APPS.md'
const SECURITY = 'docs/SECURITY.md'

describe('docs/APPS.md', () => {
  const forbidden: Array<[string, string | RegExp]> = [
    ['the owner-question section marker', j('M', '8')],
    ['an owner-question label', j('Owner', ' question')],
    ['an absolute home path', j('/Users', '/')],
    ['a Talos message id', /m_01[0-9A-Z]{20,}/],
    ['a spec revision marker', j('rev', ' 2.')],
    ['the design spec file name', j('MCP-APPS', '-SPEC')],
    ['the design review file name', j('MCP-APPS', '-REVIEW')],
  ]
  for (const [name, pattern] of forbidden) {
    it(`does not contain ${name}`, () => {
      const text = read(APPS)
      if (typeof pattern === 'string') expect(text.includes(pattern)).toBe(false)
      else expect(pattern.test(text)).toBe(false)
    })
  }

  it('has the "Differences from the original design" heading', () => {
    expect(read(APPS)).toMatch(/^## Differences from the original design$/m)
  })

  it('ends with the differences section', () => {
    const text = read(APPS)
    const at = text.indexOf('## Differences from the original design')
    expect(at).toBeGreaterThan(0)
    expect(text.slice(at).match(/^## /gm)?.length).toBe(1)
  })

  it('opens with a "Status and scope" block', () => {
    expect(read(APPS)).toMatch(/^## Status and scope$/m)
  })

  // Each term the doc tells the owner to use must still exist where the code reads it: the environment variable and the
  // `apps <sub>` commands in the bridge source, the error codes in the protocol list.
  const bridgeApps = readFileSync(join(root, 'apps/bridge/src/apps/cli.ts'), 'utf8')
  const bridgeSource = ['apps/bridge/src/config.ts', 'apps/bridge/src/apps/switch.ts']
    .map((f) => readFileSync(join(root, f), 'utf8'))
    .join('\n')
  it('mentions TALOS_APP_APPS, which the bridge reads', () => {
    expect(read(APPS)).toContain('TALOS_APP_APPS')
    expect(bridgeSource).toContain('TALOS_APP_APPS')
  })
  for (const sub of ['scan', 'login', 'strict']) {
    it(`mentions "apps ${sub}", a subcommand the bridge has`, () => {
      expect(read(APPS)).toContain(`apps ${sub}`)
      expect(bridgeApps).toContain(`case '${sub}'`)
    })
  }
  for (const code of ['app_only_unsupported', 'approval_changed', 'rate_limited', 'mac_offline']) {
    it(`mentions ${code}, a real app error code`, () => {
      expect(read(APPS)).toContain(code)
      expect(AppErrorCode.options).toContain(code)
    })
  }

  it('closes every code fence', () => {
    const fences = read(APPS).match(/^\s*```/gm) ?? []
    expect(fences.length % 2).toBe(0)
  })

  it('stays under 450 lines', () => {
    expect(read(APPS).split('\n').length).toBeLessThan(450)
  })

  it("lists what a view really sees: time zone and locale are the browser's, not hidden by the sandbox", () => {
    const row = read(APPS)
      .split('\n')
      .find((l) => l.startsWith('| Its own HTML;'))
    expect(row, 'the "Its own HTML" row exists').toBeDefined()
    const [, canSee, neverSees] = (row ?? '').split('|')
    expect(neverSees).not.toMatch(/time zone/)
    expect(canSee).toMatch(/locale|language/)
  })

  it('uses at most two em dashes', () => {
    expect((read(APPS).match(/—/g) ?? []).length).toBeLessThanOrEqual(2)
  })

  it('names only real AppErrorCode members in its troubleshooting table', () => {
    const text = read(APPS)
    const start = text.indexOf('## Troubleshooting')
    expect(start).toBeGreaterThan(0)
    const rest = text.slice(start + 3)
    const end = rest.indexOf('\n## ')
    const section = end < 0 ? rest : rest.slice(0, end)
    const codes = [...section.matchAll(/^\|\s*`([a-z_]+)`\s*\|/gm)].map((m) => m[1] as string)
    expect(codes.length).toBeGreaterThan(10)
    const real = new Set<string>(AppErrorCode.options)
    const unknown = codes.filter((c) => !real.has(c))
    expect(unknown).toEqual([])
  })

  it('documents every AppErrorCode in the troubleshooting table', () => {
    const text = read(APPS)
    const section = text.slice(text.indexOf('## Troubleshooting'))
    const missing = AppErrorCode.options.filter((c) => !new RegExp(`^\\|\\s*\`${c}\``, 'm').test(section))
    expect(missing).toEqual([])
  })
})

describe('docs/SECURITY.md', () => {
  it('has the MCP Apps section and its honest residuals', () => {
    const text = read(SECURITY)
    expect(text).toMatch(/^## MCP Apps \(opt-in\)$/m)
    expect(text).toContain('DNS rebinding')
    expect(text).toContain('Keychain')
    expect(text).toContain('readable by the agent')
  })

  it('does not promise that a failed app call stays away from the agent', () => {
    const text = read(SECURITY)
    const line = /Results of app-requested calls never reach the agent[^.]*\.[^.]*\./.exec(text)?.[0] ?? ''
    expect(line).not.toBe('') // the claim is still there
    expect(text).toMatch(
      /PostToolUseFailure|error text[^.]*(reaches|reach) the agent|failed call[^.]*(reaches|reach) the agent/i,
    )
  })

  it('does not claim a relay cannot pull files by naming ids, and lists the media.fetch limit', () => {
    // The app signs media.fetch for an id named by a row only the relay vouched for (apps/web/test/threads).
    const [protections, limits] = read(SECURITY).split('## What this does not protect against') as [string, string]
    expect(limits, 'the section exists').toBeDefined()
    expect(protections.includes('cannot pull files off the Mac by naming their ids')).toBe(false)
    expect(/media\.fetch|re-?upload/i.test(limits)).toBe(true)
  })

  it('points the apps injection corpus at smoke item S7', () => {
    expect(read(SECURITY)).toContain('smoke item S7')
  })
})

// Paths named in the docs must exist. Tokens that are not repo files are listed here on purpose.
const NOT_REPO_FILES = new Set<string>([
  'settings.local.json', // lives in the agent folder, not this repo (no slash and not a checked extension anyway)
])

describe('paths named in the apps docs', () => {
  for (const doc of [APPS, SECURITY]) {
    it(`${doc} names only files that exist`, () => {
      const text = read(doc)
      const docDir = dirname(join(root, doc))
      const missing: string[] = []
      for (const m of text.matchAll(/[\w./-]+\.(?:md|ts|sh)\b/g)) {
        const token = m[0]
        if (NOT_REPO_FILES.has(token)) continue
        // Only tokens with a directory part are repo paths; a bare file name (install.sh, cli.ts) names a file in context.
        if (!token.includes('/')) {
          if (!/^[A-Z]+\.md$/.test(token)) continue
          if (!existsSync(join(docDir, token))) missing.push(token)
          continue
        }
        const clean = token.replace(/^\.\//, '')
        const candidates = [join(root, clean), join(docDir, clean)]
        if (!candidates.some((c) => existsSync(c))) missing.push(token)
      }
      expect(missing).toEqual([])
    })
  }
})
