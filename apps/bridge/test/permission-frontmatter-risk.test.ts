// What an edit to an agent, skill or command file changes in the frontmatter keys that matter to permissions (the card's warning).
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentFileWarning,
  editedText,
  FRONTMATTER_UNCLEAR_SAYS,
  RISKY_KEYS,
  RUNNABLE_FILE_SAYS,
  RUNS_COMMAND_SAYS,
  riskyFrontmatterChange,
  TOUCHES_AGENT_FILES_SAYS,
} from '../src/permission/frontmatter-risk.ts'

const says = (k: string) => RISKY_KEYS.find((r) => r.key === k)?.says as string
const agent = (front: string, body = 'Do the work.\n') => `---\n${front}---\n${body}`
const BASE = 'name: helper\ndescription: helps\n'

describe('riskyFrontmatterChange', () => {
  test('adding hooks flags the hook sentence', () => {
    const after = agent(`${BASE}hooks:\n  PreToolUse:\n    - command: ./x.sh\n`)
    expect(riskyFrontmatterChange(agent(BASE), after)).toEqual([says('hooks')])
  })
  test('removing hooks flags too', () => {
    const before = agent(`${BASE}hooks:\n  PreToolUse:\n    - command: ./x.sh\n`)
    expect(riskyFrontmatterChange(before, agent(BASE))).toEqual([says('hooks')])
  })
  test('permissionMode default to bypassPermissions flags', () => {
    expect(
      riskyFrontmatterChange(
        agent(`${BASE}permissionMode: default\n`),
        agent(`${BASE}permissionMode: bypassPermissions\n`),
      ),
    ).toEqual([says('permissionMode')])
  })
  test('a changed model flags', () => {
    expect(riskyFrontmatterChange(agent(`${BASE}model: sonnet\n`), agent(`${BASE}model: opus\n`))).toEqual([
      says('model'),
    ])
  })
  test('a changed multi-line tools list flags', () => {
    const before = agent(`${BASE}tools:\n  - Read\n  - Grep\n`)
    const after = agent(`${BASE}tools:\n  - Read\n  - Grep\n  - Bash\n`)
    expect(riskyFrontmatterChange(before, after)).toEqual([says('tools')])
  })
  test('allowed-tools and allowedTools are the same key', () => {
    expect(riskyFrontmatterChange(agent(`${BASE}allowed-tools: Read\n`), agent(`${BASE}allowedTools: Bash\n`))).toEqual(
      [says('allowed-tools')],
    )
  })
  test('mcpServers flags', () => {
    expect(riskyFrontmatterChange(agent(BASE), agent(`${BASE}mcpServers: [x]\n`))).toEqual([says('mcpServers')])
  })
  test('changing only description gives []', () => {
    expect(
      riskyFrontmatterChange(
        agent(`${BASE}model: sonnet\n`),
        agent('name: helper\ndescription: other\nmodel: sonnet\n'),
      ),
    ).toEqual([])
  })
  test('a body-only change gives []', () => {
    expect(
      riskyFrontmatterChange(agent(`${BASE}model: sonnet\n`, 'one\n'), agent(`${BASE}model: sonnet\n`, 'two\n')),
    ).toEqual([])
  })
  test('an unclear frontmatter (a tab indent) gives the unclear sentence', () => {
    const bad = agent(`${BASE}tools:\n\t- Read\n`)
    expect(riskyFrontmatterChange(agent(BASE), bad)).toEqual([FRONTMATTER_UNCLEAR_SAYS])
    expect(riskyFrontmatterChange(bad, agent(BASE))).toEqual([FRONTMATTER_UNCLEAR_SAYS])
  })
  test('a flow mapping that changes flags every key outside the harmless ones it has', () => {
    const before = agent('{name: a, model: sonnet}\n')
    const after = agent('{name: b, model: sonnet}\n')
    expect(riskyFrontmatterChange(before, after)).toEqual([says('model'), says('name')])
    expect(riskyFrontmatterChange(before, before)).toEqual([])
    expect(riskyFrontmatterChange(agent('{description: a}\n'), agent('{description: b}\n'))).toEqual([])
  })
  test('a file with no frontmatter that gains one with a risky key flags it', () => {
    expect(riskyFrontmatterChange('just text\n', agent(`${BASE}permissionMode: plan\n`))).toEqual([
      says('permissionMode'),
      says('name'),
    ])
  })
})

describe('every key outside the harmless four warns', () => {
  const generic = (k: string) => `this changes a setting (${k}) that can change what the agent may do`
  test('a merge key warns, in a flow value, a block value and quoted', () => {
    const flow = agent(`${BASE}<<: {hooks: {PreToolUse: []}, permissionMode: bypassPermissions}\n`)
    const block = agent(`${BASE}<<:\n  hooks: {PreToolUse: []}\n  permissionMode: bypassPermissions\n`)
    const quoted = agent(`${BASE}"<<": {model: opus}\n`)
    for (const after of [flow, block, quoted]) {
      const r = riskyFrontmatterChange(agent(BASE), after)
      expect(r).toHaveLength(1)
      expect(r[0]).toContain('(<<)')
    }
    // present on both sides and unchanged: still said
    expect(riskyFrontmatterChange(flow, flow)).toHaveLength(1)
  })
  test('context and skills warn', () => {
    expect(riskyFrontmatterChange(agent(BASE), agent(`${BASE}context: fork\n`))).toEqual([generic('context')])
    expect(riskyFrontmatterChange(agent(`${BASE}skills:\n  - a\n`), agent(`${BASE}skills:\n  - b\n`))).toEqual([
      generic('skills'),
    ])
  })
  test('every harmless key can change without a word', () => {
    const b = agent('name: a\ndescription: x\ncolor: red\nargument-hint: x\nwhen_to_use: now\n')
    const a = agent('name: a\ndescription: y\ncolor: blue\nargument-hint: y\nwhen_to_use: later\n')
    expect(riskyFrontmatterChange(b, a)).toEqual([])
  })
  test('a rename warns: an agent the owner allowed hooks for must not quietly become general-purpose', () => {
    const hooked = 'hooks:\n  PreToolUse:\n    - command: ./x.sh\n'
    expect(riskyFrontmatterChange(agent(`name: helper\n${hooked}`), agent(`name: general-purpose\n${hooked}`))).toEqual(
      [says('name')],
    )
  })
  test('a key that is not a plain name is not echoed', () => {
    expect(riskyFrontmatterChange(agent(BASE), agent(`${BASE}"a b c d": 1\n`))[0]).toContain(
      '(a key that is not a plain name)',
    )
  })
})

describe('agentFileWarning without the relay', () => {
  const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'afw-')))
  const AG = agent(`${BASE}model: sonnet\n`)
  test('a file that is not .md under a watched folder is a program', () => {
    const d = tmp()
    expect(
      agentFileWarning('Write', { file_path: join(d, '.claude', 'skills', 'run.sh'), content: 'x' }, undefined),
    ).toEqual([RUNNABLE_FILE_SAYS])
  })
  test('a body line that runs a command warns; one already there does not', () => {
    const d = tmp()
    mkdirSync(join(d, '.claude', 'skills'), { recursive: true })
    const f = join(d, '.claude', 'skills', 's.md')
    writeFileSync(f, `${AG}run !\`ls\`\n`)
    expect(
      agentFileWarning('Edit', { file_path: f, old_string: 'Do the work.', new_string: 'Do it.' }, undefined),
    ).toEqual([])
    expect(agentFileWarning('Edit', { file_path: f, old_string: '!`ls`', new_string: '!`rm x`' }, undefined)).toEqual([
      RUNS_COMMAND_SAYS,
    ])
    expect(
      agentFileWarning(
        'Write',
        { file_path: join(d, '.claude', 'skills', 'n.md'), content: '```!\nls\n```\n' },
        undefined,
      ),
    ).toEqual([RUNS_COMMAND_SAYS])
  })
  test('spellings: an upper-case folder after .claude, a config folder not named .claude, a symlinked parent', () => {
    const d = tmp()
    const content = agent(`${BASE}hooks: x\n`)
    mkdirSync(join(d, '.claude', 'Agents'), { recursive: true })
    expect(
      agentFileWarning('Write', { file_path: join(d, '.claude', 'Agents', 'a.md'), content }, undefined),
    ).toHaveLength(2)
    // a config folder that is not called .claude: only when it is one the bridge knows
    mkdirSync(join(d, 'cfg', 'agents'), { recursive: true })
    const at = join(d, 'cfg', 'agents', 'a.md')
    expect(agentFileWarning('Write', { file_path: at, content }, undefined)).toEqual([])
    expect(agentFileWarning('Write', { file_path: at, content }, undefined, [join(d, 'CFG')])).toHaveLength(2)
    // the path as written has no watched folder; the folder it leads to does
    symlinkSync(join(d, '.claude'), join(d, 'link'))
    expect(
      agentFileWarning('Write', { file_path: join(d, 'link', 'agents', 'a.md'), content }, undefined),
    ).toHaveLength(2)
    mkdirSync(join(d, '.claude', 'agents'), { recursive: true })
    symlinkSync(join(d, '.claude', 'agents'), join(d, 'plain'))
    expect(agentFileWarning('Write', { file_path: join(d, 'plain', 'a.md'), content }, undefined)).toHaveLength(2)
  })
  test('a project’s own src/commands and other folders do not warn', () => {
    const d = tmp()
    mkdirSync(join(d, 'src', 'commands'), { recursive: true })
    for (const p of [join(d, 'src', 'commands', 'foo.ts'), join(d, 'skills', 'x.md'), join(d, 'other', 'a.md')])
      expect(agentFileWarning('Write', { file_path: p, content: agent(`${BASE}hooks: x\n`) }, undefined), p).toEqual([])
  })
  test('a NotebookEdit under a watched folder is unclear', () => {
    expect(agentFileWarning('NotebookEdit', { notebook_path: '/h/.claude/skills/n.ipynb' }, undefined)).toEqual([
      FRONTMATTER_UNCLEAR_SAYS,
    ])
  })
  test('a Bash command naming agent, skill or command files warns', () => {
    for (const c of [
      'cp x ~/.claude/agents/a.md',
      'echo hi > .claude/skills/s/SKILL.md',
      'ls "/h/.claude/commands"',
      'rm /cfg/dir/agents/a.md',
    ])
      expect(agentFileWarning('Bash', { command: c }, undefined, ['/cfg/dir']), c).toEqual([TOUCHES_AGENT_FILES_SAYS])
    expect(agentFileWarning('Bash', { command: 'ls ~/.claude/settings.json' }, undefined, ['/cfg/dir'])).toEqual([])
  })
})

describe('editedText', () => {
  const cur = () => 'alpha beta alpha'
  test('Write: the current file (or nothing) and the content', () => {
    expect(editedText('Write', { content: 'x' }, cur)).toEqual({ before: 'alpha beta alpha', after: 'x' })
    expect(editedText('Write', { content: 'x' }, () => null)).toEqual({ before: '', after: 'x' })
  })
  test('Edit: applied; replace_all honoured; ambiguous or missing old_string is null', () => {
    expect(editedText('Edit', { old_string: 'beta', new_string: '$&' }, cur)?.after).toBe('alpha $& alpha')
    expect(editedText('Edit', { old_string: 'alpha', new_string: 'z', replace_all: true }, cur)?.after).toBe('z beta z')
    expect(editedText('Edit', { old_string: 'alpha', new_string: 'z' }, cur)).toBeNull()
    expect(editedText('Edit', { old_string: 'nope', new_string: 'z' }, cur)).toBeNull()
    expect(editedText('Edit', { old_string: 'a', new_string: 'z' }, () => null)).toBeNull()
  })
  test('MultiEdit: in order; one that fails makes it null', () => {
    const edits = [
      { old_string: 'beta', new_string: 'gamma' },
      { old_string: 'gamma', new_string: 'delta' },
    ]
    expect(editedText('MultiEdit', { edits }, cur)?.after).toBe('alpha delta alpha')
    expect(editedText('MultiEdit', { edits: [...edits, { old_string: 'beta', new_string: 'x' }] }, cur)).toBeNull()
  })
  test('NotebookEdit is null', () => {
    expect(editedText('NotebookEdit', {}, cur)).toBeNull()
  })
})
