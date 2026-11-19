// The reply tool notes a shell command written as inline code (the web app draws no Run button on those). The note goes on the
// tool result only; the message is sent as written. Real bridge on the FakeRelay.
import { afterEach, describe, expect, test } from 'bun:test'
import { INLINE_COMMAND_WORDS, inlineCommands } from '../src/inline-commands.ts'
import { type Harness, startHarness } from './helpers.ts'

let h: Harness | undefined
afterEach(async () => {
  await h?.stop()
  h = undefined
})

const B = '`'
const FENCE = B.repeat(3)
const NOTE = 'Commands go in a ```sh block so Run appears:'
const say = async (t: string) => {
  h ??= await startHarness()
  const res = await h.bridge.callTool('reply', { thread_id: 'general', text: t })
  return { res, out: res.content[0]?.text ?? '' }
}

describe('reply: a command in inline code', () => {
  test('inline `git status` gets a note on the result; the message goes out unchanged', async () => {
    const text = `Check it with ${B}git status${B} please.`
    const { res, out } = await say(text)
    expect(res.isError).toBeFalsy()
    expect(out).toMatch(/^sent \(id: m_[0-9A-HJKMNP-TV-Z]{26}\)/)
    expect(out).toContain(`${NOTE} ${B}git status${B}`)
    const f = await h?.relay.expectFrame('reply', (r) => r.message.text === text, { direction: 'from_bridge' })
    expect(f?.message.text).toBe(text)
  })

  test('a ```sh block gets no note', async () => {
    const { out } = await say(`Run:\n\n${FENCE}sh\ngit status\n${FENCE}\n`)
    expect(out).not.toContain('Run appears')
  })

  test('paths and file names in backticks get no note', async () => {
    const { out } = await say(`See ${B}apps/bridge/src/x.ts${B}, ${B}~/.talos${B} and ${B}git${B}.`)
    expect(out).not.toContain('Run appears')
  })

  test('a span inside a ``` or ~~~ fence gets no note', async () => {
    const { out } = await say(`${FENCE}md\nuse ${B}git status${B}\n${FENCE}\n\n~~~\n${B}npm test${B}\n~~~\n`)
    expect(out).not.toContain('Run appears')
  })

  test('several matches name the first and count the rest', async () => {
    const { out } = await say(`${B}git status${B} then ${B}npm test${B} then ${B}rm -rf x${B}`)
    expect(out).toContain(`${B}git status${B} and 2 more`)
  })

  test('a failed send gets no note', async () => {
    h = await startHarness()
    const res = await h.bridge.callTool('reply', { thread_id: 'nope', text: `${B}git status${B}` })
    expect(res.isError).toBe(true)
    expect(res.content[0]?.text).not.toContain('Run appears')
  })
})

describe('inlineCommands', () => {
  test('hostile text: emoji, combining marks, bidi, NUL and a huge unclosed run never throw and only real spans match', () => {
    expect(inlineCommands(`🚀 ${B}git 🚀${B} é${B}git́${B}`)).toEqual(['git 🚀'])
    expect(inlineCommands(`${B}‮git status${B}`)).toEqual([])
    expect(inlineCommands(`${B}git\u0000 x${B}`)).toEqual([])
    expect(inlineCommands(`${B.repeat(50_000)}git status`)).toEqual([])
    // 250 runs of different lengths, none closing: no work blows up
    const ladder = Array.from({ length: 250 }, (_, k) => `${B.repeat(k + 1)}git status `).join('')
    expect(inlineCommands(ladder)).toEqual([])
  })
  test('escaped backticks are not a span; double-backtick spans are; a bare command word is not', () => {
    expect(inlineCommands(`\\${B}git status\\${B}`)).toEqual([])
    expect(inlineCommands(`${B}${B} git status ${B}${B}`)).toEqual(['git status'])
    expect(inlineCommands(`${B}git${B} and ${B}talos-app${B}`)).toEqual([])
    expect(inlineCommands(`${B}git-lfs pull${B} ${B}Git status${B}`)).toEqual([])
  })
  test('a fence closes only on a fence at least as long; an unclosed fence hides the rest', () => {
    expect(inlineCommands(`${B.repeat(4)}\n${FENCE}\n${B}git status${B}\n${B.repeat(4)}\n${B}npm i${B}`)).toEqual([
      'npm i',
    ])
    expect(inlineCommands(`${FENCE}\n${B}git status${B}`)).toEqual([])
  })
  test('the list is one exported list with the agreed words', () => {
    expect(INLINE_COMMAND_WORDS).toContain('talos-app')
    expect(INLINE_COMMAND_WORDS).toContain('sudo')
    expect(new Set(INLINE_COMMAND_WORDS).size).toBe(INLINE_COMMAND_WORDS.length)
  })
})
