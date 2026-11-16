// A background sub-agent's Bash ask as the real Claude Code 2.1.322 draws it (desktop Tests/Fixtures/real-2.1.322, README): the
// owner's case of 2026-11-11, where `This shell -c script runs rm and could not be checked` sat in a thread session's pane. The
// Linux twin of PromptDetector322Tests.swift, on the same captures; nothing is built by hand unless the test says SYNTHETIC.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { detectPrompt, isIdle, isToolPrompt, type Prompt } from '../../src/supervisor/dialog-reader.ts'
import { PromptWatch } from '../../src/supervisor/prompt-watch.ts'
import { liveDialog } from '../../src/supervisor/screen.ts'
import { parseCapture } from '../../src/supervisor/tmux-commands.ts'

const FIX = resolve(import.meta.dir, '../../../desktop/Tests/Fixtures')
const rows = (name: string, dir = 'real-2.1.322') =>
  parseCapture(readFileSync(resolve(FIX, dir, `${name}.txt`), 'utf8'))
const prompt = (name: string, dir = 'real-2.1.322'): Prompt => {
  const p = detectPrompt(rows(name, dir))
  if (!p) throw new Error(`${name} is a prompt`)
  return p
}

const DIALOGS = [
  'perm-subagent-rm-unchecked',
  'perm-subagent-rm-unchecked-cursor2',
  'perm-subagent-rm-two-agents',
  'perm-subagent-rm-queued-3',
  'perm-subagent-rm-queued-4',
  'perm-subagent-rm-withheld',
]

describe('the 2.1.322 sub-agent captures', () => {
  for (const name of DIALOGS)
    it(`${name}: the sub-agent's Bash ask is found as a Bash command`, () => {
      const screen = rows(name)
      expect(screen.some((r) => r.includes('Bash command · from the talos-builder agent'))).toBe(true) // control
      expect(screen.some((r) => r.includes('This shell -c script runs rm and could not be checked'))).toBe(true) // control
      const p = prompt(name)
      expect(p.kind).toBe('bash_command')
      expect(p.title).toBe('Bash command')
      expect(p.question).toBe('Do you want to proceed?')
      expect(liveDialog(screen).kind).toBe('none')
    })

  it('the footer that names background agents is a footer; the cursor is not the prompt', () => {
    const a = prompt('perm-subagent-rm-unchecked')
    const b = prompt('perm-subagent-rm-unchecked-cursor2')
    expect(a.footer && b.footer).toBe(true)
    expect(a.signature).toBe(b.signature)
    expect(a.region).not.toEqual(b.region)
  })

  it('the queue counter in the header (`1 of 3`, then `1 of 4`) is not part of the prompt', () => {
    const plain = rows('perm-subagent-rm-two-agents')
    const three = rows('perm-subagent-rm-queued-3')
    const four = rows('perm-subagent-rm-queued-4')
    // control: the three captures differ in the counter
    expect(plain.some((r) => r.trimEnd().endsWith('1 of 3'))).toBe(false)
    expect(three.some((r) => r.trimEnd().endsWith('1 of 3'))).toBe(true)
    expect(four.some((r) => r.trimEnd().endsWith('1 of 4'))).toBe(true)
    const all = [plain, three, four].map((s) => detectPrompt(s) as Prompt)
    expect(new Set(all.map((p) => p.signature)).size).toBe(1)
    expect(new Set(all.map((p) => p.hash)).size).toBe(1)
    expect(new Set(all.map((p) => JSON.stringify(p.region))).size).toBe(1)
    expect(all.every((p) => p.kind === 'bash_command')).toBe(true)
  })

  it('a counter that ticks neither holds the prompt back nor announces it twice', () => {
    const frames = ['perm-subagent-rm-two-agents', 'perm-subagent-rm-queued-3', 'perm-subagent-rm-queued-4'].map((n) =>
      rows(n),
    )
    const watch = new PromptWatch()
    const appeared: number[] = []
    for (let t = 0; t < 30; t++) {
      const screen = frames[Math.min(Math.floor(t / 3), 2)] as string[] // the counter changes at 3 s and at 6 s
      if (watch.observe(detectPrompt(screen), t, { settle: 5 }).kind === 'appeared') appeared.push(t)
    }
    expect(appeared).toEqual([5])
  })

  it('SYNTHETIC: digits at the end of a command row are the command; only the header row loses a counter', () => {
    const base = rows('perm-subagent-rm-withheld')
    const a = base.map((r) => (r.includes('scripted test call') ? ' echo        1 of 3' : r))
    const b = base.map((r) => (r.includes('scripted test call') ? ' echo        1 of 4' : r))
    expect(a).not.toEqual(b)
    expect(detectPrompt(a)?.hash).not.toBe(detectPrompt(b)?.hash)
  })

  it('a command too long to show (its box says so) is still the Bash ask', () => {
    expect(rows('perm-subagent-rm-withheld').some((r) => r.includes('value cannot be shown in full'))).toBe(true)
    expect(prompt('perm-subagent-rm-withheld').kind).toBe('bash_command')
  })

  for (const name of ['idle-agents-panel', 'idle-after-esc'])
    it(`${name}: the idle box with the agents panel under its status bar is idle, and not a prompt`, () => {
      const screen = rows(name)
      if (name === 'idle-agents-panel')
        expect(
          screen
            .filter((r) => r.trim() !== '')
            .at(-1)
            ?.includes('talos-builder'),
        ).toBe(true) // control: the panel is last
      expect(detectPrompt(screen)).toBeNull()
      expect(isIdle(screen)).toBe(true)
    })
})

describe("a tool's ask (what the 60 s hold cap counts)", () => {
  for (const [dir, name, tool] of [
    ['real-2.1.322', 'perm-subagent-rm-unchecked', true],
    ['real-2.1.322', 'perm-subagent-rm-unchecked-cursor2', true],
    ['real-2.1.318', 'bash-permission', true],
    ['real-2.1.318', 'bash-permission-cursor2', true],
    ['real-2.1.318', 'write-permission', true],
    ['real-2.1.318', 'askuser-select', false],
    ['real-2.1.318', 'perm-askuserquestion', false],
    ['real-2.1.318', 'onboarding-theme', false],
  ] as const)
    it(`${name}: ${tool ? 'a tool’s ask' : 'the owner’s own question'}`, () => {
      expect(isToolPrompt(prompt(name, dir))).toBe(tool)
    })

  for (const [dir, name, tool] of [
    ['real-2.1.322', 'perm-subagent-rm-unchecked', true],
    ['real-2.1.318', 'write-permission', true],
    ['real-2.1.318', 'askuser-select', false],
  ] as const)
    it(`SYNTHETIC: ${name} with its header cut off is ${tool ? 'still' : 'still not'} a tool's ask`, () => {
      const all = rows(name, dir)
      const from = all.findIndex((r) => r.includes('Do you want to') || r.includes('Which color'))
      expect(from).toBeGreaterThan(0)
      const p = detectPrompt(all.slice(from)) as Prompt
      expect(p).not.toBeNull()
      if (tool) expect(p.kind).toBe('other')
      expect(isToolPrompt(p)).toBe(tool)
    })

  it('SYNTHETIC: the mode line with its hint pushed off, under a status-script row, over the agents panel, is idle', () => {
    const screen = [...rows('idle-agents-panel')]
    const at = screen.findIndex((r) => r.includes('bypass permissions on'))
    expect(at).toBeGreaterThan(0)
    screen[at] = '  ⏵⏵ bypass permissions on · 3 shells'
    screen.splice(at, 0, '  Opus 5.5 | ██░░ 53% | 7d: 70%')
    expect(isIdle(screen)).toBe(true)
    expect(detectPrompt(screen)).toBeNull()
    const ask = rows('perm-subagent-rm-withheld').map((r) =>
      r.includes('scripted test call') ? ' echo bypass permissions on (shift+tab to cycle)' : r,
    )
    expect(isIdle(ask)).toBe(false) // a prompt is not idle, whatever its command says
    expect(detectPrompt(ask)?.kind).toBe('bash_command')
  })
})
