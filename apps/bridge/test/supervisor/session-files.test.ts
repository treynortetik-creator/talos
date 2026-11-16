// What a thread session's folders may hold besides their settings (worker/session-files.ts): no link in .claude, at .mcp.json or
// at a .env file, and no skill, command or subagent whose frontmatter carries a refused key (the shared table), read as Claude
// Code reads it. Temp folders only.
import { afterEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrontmatterUnclear, frontmatterKeys } from '../../src/worker/frontmatter-scan.ts'
import { FIX } from '../../src/worker/project-settings.ts'
import { folderChain, frontmatterProblem, linkProblem, sessionFilesProblem } from '../../src/worker/session-files.ts'

const dirs: string[] = []
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'talos-sessfiles-')))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const md = (folder: string, rel: string, text: string) => {
  const p = join(folder, '.claude', rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
const KIT = join(import.meta.dir, '..', '..', '..', '..', 'kit')

describe('the folders checked: the session’s own, every folder up to each repo root, and the roots', () => {
  it('a folder two below its root: both folders in between; a root elsewhere (a worktree’s main checkout) only itself', () => {
    expect(folderChain('/r/a/b', ['/r'])).toEqual(['/r/a/b', '/r/a', '/r'])
    expect(folderChain('/w', ['/w', '/main', '/main/.git'])).toEqual(['/w', '/main', '/main/.git'])
    expect(folderChain('/r/a', ['/r', '/elsewhere'])).toEqual(['/r/a', '/r', '/elsewhere'])
  })
})

describe('links: nothing this check reads may lead elsewhere', () => {
  it('a link at .claude, anywhere under it, at .mcp.json or at a .env file: refused with the path and the fix', () => {
    const cases: Array<(d: string) => string> = [
      (d) => (symlinkSync('/', join(d, '.claude')), join(d, '.claude')),
      (d) => (
        mkdirSync(join(d, '.claude', 'skills', 'x'), { recursive: true }),
        symlinkSync('/etc/passwd', join(d, '.claude', 'skills', 'x', 'SKILL.md')),
        join(d, '.claude', 'skills', 'x', 'SKILL.md')
      ),
      (d) => (
        mkdirSync(join(d, '.claude')),
        symlinkSync('/x', join(d, '.claude', 'settings.local.json')),
        join(d, '.claude', 'settings.local.json')
      ),
      (d) => (symlinkSync('/x', join(d, '.mcp.json')), join(d, '.mcp.json')),
      (d) => (symlinkSync('/x', join(d, '.env.local')), join(d, '.env.local')),
    ]
    for (const make of cases) {
      const d = tmp()
      const path = make(d)
      const why = linkProblem(d)
      expect(why, path).toBe(`${path} is a link: ${FIX}`)
    }
  })
  it('control: plain files and folders, and a link elsewhere in the folder, are fine', () => {
    const d = tmp()
    md(d, 'settings.json', '{}')
    writeFileSync(join(d, '.mcp.json'), '{}')
    writeFileSync(join(d, '.env'), 'X=1\n')
    symlinkSync('/', join(d, 'src-link'))
    expect(linkProblem(d)).toBeNull()
    expect(linkProblem(tmp())).toBeNull()
  })
})

describe('skills, commands and subagents: no hooks, allowed tools, MCP servers or permission mode of their own', () => {
  it('each refused key, in each kind of file, at any depth: refused with the file, the key and the fix', () => {
    for (const key of ['hooks', 'allowed-tools', 'allowedTools', 'mcpServers', 'permissionMode', 'Allowed_Tools'])
      for (const rel of ['skills/a/SKILL.md', 'commands/deep/x.md', 'agents/h.md']) {
        const d = tmp()
        md(d, rel, `---\nname: x\n${key}: y\n---\nbody\n`)
        const why = frontmatterProblem(d)
        expect(why, `${key} ${rel}`).toContain(join(d, '.claude', rel))
        expect(why, `${key} ${rel}`).toContain(`has ${key} in its frontmatter`)
        expect(why, `${key} ${rel}`).toEndWith(`: ${FIX}`)
      }
  })
  it('the one reader of all three (the Mac’s, the hook’s, this): every shared case in kit/scripts/frontmatter-cases.json', () => {
    const cases = JSON.parse(readFileSync(join(KIT, 'scripts', 'frontmatter-cases.json'), 'utf8')) as Array<{
      name: string
      text: string
      keys?: string[]
      unclear?: boolean
    }>
    expect(cases.length).toBeGreaterThan(30)
    for (const c of cases) {
      let got: string[] | 'unclear'
      try {
        got = frontmatterKeys(c.text)
      } catch (e) {
        if (!(e instanceof FrontmatterUnclear)) throw e
        got = 'unclear'
      }
      expect(got, c.name).toEqual(c.unclear ? 'unclear' : (c.keys as string[]))
    }
  })
  it('a frontmatter the reader cannot read for certain refuses, naming what it met', () => {
    const d = tmp()
    md(d, 'agents/a.md', '---\n"hoo\\x6bs": x\n---\n')
    expect(frontmatterProblem(d)).toContain('has a key with an escape')
  })
  it('a FIFO, a link, or a file too big, named like a skill: refused without stalling or following', () => {
    const d = tmp()
    mkdirSync(join(d, '.claude', 'agents'), { recursive: true })
    execFileSync('mkfifo', [join(d, '.claude', 'agents', 'x.md')])
    expect(frontmatterProblem(d)).toContain('is not a plain file')
    const e = tmp()
    md(e, 'commands/big.md', `---\nname: x\n---\n${'y'.repeat(300 * 1024)}`)
    expect(frontmatterProblem(e)).toContain('is not a plain file of at most 256 KB')
  })
  it('control: the kit’s own skills, commands and subagents pass (a description with a colon in it included)', () => {
    expect(frontmatterProblem(KIT)).toBeNull()
    expect(linkProblem(KIT)).toBeNull()
  })
  it('the session check covers every folder up to the repo root', () => {
    const repo = tmp()
    mkdirSync(join(repo, '.git'))
    const sub = join(repo, 'a', 'b')
    mkdirSync(sub, { recursive: true })
    md(join(repo, 'a'), 'skills/s/SKILL.md', '---\nhooks: {}\n---\n')
    expect(sessionFilesProblem(folderChain(sub, [repo]))).toContain(
      join(repo, 'a', '.claude', 'skills', 's', 'SKILL.md'),
    )
  })
})
