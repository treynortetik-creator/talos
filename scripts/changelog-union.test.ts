// CHANGELOG.md merges as a union (.gitattributes): two landings that each add an entry at the top no longer conflict when
// gate-push rebases one onto the other. Each such conflict cost a full re-gate (8 landings bounced on 2026-11-15).
// gate-reads: .gitattributes biome.json
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Owner',
  GIT_AUTHOR_EMAIL: 'owner@example.com',
  GIT_COMMITTER_NAME: 'Owner',
  GIT_COMMITTER_EMAIL: 'owner@example.com',
}
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}
const entry = (title: string) => `## ${title}\n\n- ${title} changed.\n\n`

describe('CHANGELOG.md merges as a union', () => {
  it('two entries added at the top on both sides rebase cleanly, both kept whole', () => {
    const d = mkdtempSync(join(tmpdir(), 'talos-changelog-union-'))
    dirs.push(d)
    git(d, 'init', '-q', '-b', 'main')
    copyFileSync(join(repoRoot, '.gitattributes'), join(d, '.gitattributes'))
    const head = '# Changelog\n\n'
    writeFileSync(join(d, 'CHANGELOG.md'), `${head}${entry('Older')}`)
    git(d, 'add', '-A')
    git(d, 'commit', '-qm', 'base')
    git(d, 'checkout', '-qb', 'mine')
    writeFileSync(join(d, 'CHANGELOG.md'), `${head}${entry('Mine')}${entry('Older')}`)
    git(d, 'commit', '-qam', 'mine')
    git(d, 'checkout', '-q', 'main')
    writeFileSync(join(d, 'CHANGELOG.md'), `${head}${entry('Theirs')}${entry('Older')}`)
    git(d, 'commit', '-qam', 'theirs')
    git(d, 'checkout', '-q', 'mine')
    const r = git(d, 'rebase', 'main')
    expect(r.status, r.out).toBe(0)
    const text = readFileSync(join(d, 'CHANGELOG.md'), 'utf8')
    // main's entry first, then the rebased one, then the old; a union can drop the blank line between two new entries (both
    // sides end in the same blank line), which a heading doesn't need
    const at = (s: string) => text.indexOf(s)
    for (const t of ['Theirs', 'Mine', 'Older']) {
      expect(text).toContain(`## ${t}\n\n- ${t} changed.\n`)
    }
    expect(at('## Theirs')).toBeLessThan(at('## Mine'))
    expect(at('## Mine')).toBeLessThan(at('## Older'))
    expect(text.startsWith(head)).toBe(true)
    expect(text).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m)
    // the gate's lint (biome check over the tree) must take the union's output as it is
    copyFileSync(join(repoRoot, 'biome.json'), join(d, 'biome.json'))
    const lint = spawnSync(join(repoRoot, 'node_modules/.bin/biome'), ['check', 'CHANGELOG.md'], {
      cwd: d,
      encoding: 'utf8',
    })
    expect(lint.status, `${lint.stdout}${lint.stderr}`).toBe(0)
  })

  it('only CHANGELOG.md is a union: any other file still conflicts', () => {
    const attrs = readFileSync(join(repoRoot, '.gitattributes'), 'utf8')
    expect(attrs).toMatch(/^CHANGELOG\.md merge=union$/m)
    expect(attrs.match(/merge=union/g)).toHaveLength(1)
  })
})
