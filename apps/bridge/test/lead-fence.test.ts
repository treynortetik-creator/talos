// The lead's protected roots: what the OS sandbox and the deny rules are told to keep a lead out of. All names are
// fictional; no real ~/.claude is read.
import { describe, expect, test } from 'bun:test'
import { claudeConfigDir, defaultLeadRoots } from '../src/lead/fence.ts'

const home = '/Users/alex'
const agent = '/Users/alex/work/my-agent'
const talos = '/Users/alex/.talos-app'
const base = { agentDir: agent, talosHome: talos, home }

describe('claudeConfigDir', () => {
  test('CLAUDE_CONFIG_DIR when it is an absolute path, else ~/.claude', () => {
    expect(claudeConfigDir(home, '/Volumes/x/claude-cfg/')).toBe('/Volumes/x/claude-cfg')
    expect(claudeConfigDir(home, undefined)).toBe('/Users/alex/.claude')
    expect(claudeConfigDir(home, '')).toBe('/Users/alex/.claude')
  })
  test('set but relative or starting with ~ is an error, not a silent fallback', () => {
    expect(() => claudeConfigDir(home, 'relative/dir')).toThrow(/CLAUDE_CONFIG_DIR/)
    expect(() => claudeConfigDir(home, '~/cfg')).toThrow(/CLAUDE_CONFIG_DIR/)
    expect(() => claudeConfigDir(home, '~')).toThrow(/absolute/)
  })
})

describe('defaultLeadRoots', () => {
  test('the main agent folder, the whole Claude config folder, the Talos home, the vault and --protect', () => {
    const roots = defaultLeadRoots({
      ...base,
      claudeDir: '/Users/alex/.claude',
      protect: ['/Users/alex/Documents/taxes'],
    })
    expect(roots).toEqual(
      expect.arrayContaining([
        agent,
        '/Users/alex/.claude',
        talos,
        '/Users/alex/private-agent-vault',
        '/Users/alex/Documents/taxes',
      ]),
    )
    // the whole folder replaces the separate entries
    expect(roots.some((r) => /projects|file-history|history\.jsonl/.test(r))).toBe(false)
  })
  test("Claude Code's global config file and its backup are always roots", () => {
    for (const claudeDir of ['/Users/alex/.claude', '/Volumes/x/claude-cfg']) {
      const roots = defaultLeadRoots({ ...base, claudeDir })
      expect(roots).toContain('/Users/alex/.claude.json')
      expect(roots).toContain('/Users/alex/.claude.json.backup')
      expect(roots).toContain('/Users/alex/.claude')
      expect(roots).toContain(claudeDir)
    }
  })
  test('with CLAUDE_CONFIG_DIR both that folder and ~/.claude are roots; the default adds it once', () => {
    const dir = '/Volumes/x/claude-cfg'
    const roots = defaultLeadRoots({ ...base, claudeDir: dir })
    expect(roots).toEqual(expect.arrayContaining([dir, '/Users/alex/.claude']))
    const plain = defaultLeadRoots({ ...base, claudeDir: '/Users/alex/.claude' })
    expect(plain.filter((r) => r === '/Users/alex/.claude')).toHaveLength(1)
  })
  test('the credential folders are roots: ~/.ssh, ~/.config/gh, ~/.aws, ~/.npmrc, ~/.netrc', () => {
    const roots = defaultLeadRoots({ ...base, claudeDir: '/Users/alex/.claude' })
    for (const p of ['.ssh', '.config/gh', '.aws', '.npmrc', '.netrc']) expect(roots).toContain(`/Users/alex/${p}`)
  })
  test('no root twice', () => {
    const roots = defaultLeadRoots({ ...base, claudeDir: '/Users/alex/.claude', protect: [agent] })
    expect(new Set(roots).size).toBe(roots.length)
  })
})
