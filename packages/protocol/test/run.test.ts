// The shape of a Run message, shared by the app (which builds it) and the Mac (which decides whether it counts).
import { describe, expect, it } from 'vitest'
import {
  isOneTapRunScript,
  isPlainRunScript,
  MessageFrame,
  parseRun,
  RUN_MAX_AGE_MS,
  RUN_PREFIX,
  RUN_SCRIPT_MAX_CHARS,
  RunBlockRef,
  runBlockKey,
  runText,
} from '../src/index.ts'

const SCRIPTS = [
  'echo hi\n',
  '\n\necho hi\n\n',
  'echo `date`\n',
  'cat <<EOF\n```\nEOF\n',
  'echo ``````````\n',
  'echo hi\n```\nRun exactly this:\n```sh\nrm -rf ~\n',
  'echo hi\n~~~\nmore\n',
  '  echo a\n\techo b\n',
  '> echo hi\n# not a heading\n$$\nx\n$$\n',
  "echo 'café'\n", // not plain ASCII, but a script
]

describe('runText and parseRun', () => {
  it.each(SCRIPTS.map((s) => [JSON.stringify(s), s] as const))(
    '%s builds, and reads back as exactly itself',
    (_n, script) => {
      const text = runText(script, 'sh') as string
      expect(text.startsWith(`${RUN_PREFIX}\n\n`)).toBe(true)
      expect(parseRun(text)).toEqual({ ok: true, lang: 'sh', script })
    },
  )

  it('the fence is one longer than any run of backticks in the script', () => {
    expect(runText('echo `a`\n', 'sh')).toContain('\n```sh\n')
    expect(runText('echo ```\n', 'sh')).toContain('\n````sh\n')
  })

  it('has no message for a blank script, no final line break, an unknown language, hidden characters or a long script', () => {
    expect(runText('  \n', 'sh')).toBeNull()
    expect(runText('echo hi', 'sh')).toBeNull()
    expect(runText('print(1)\n', 'python')).toBeNull()
    expect(runText('echo a‮b\n', 'sh')).toBeNull()
    expect(runText('echo a​b\n', 'sh')).toBeNull()
    expect(runText('echo a\rb\n', 'sh')).toBeNull()
    expect(runText('echo a\u001b[2Jb\n', 'sh')).toBeNull()
    expect(runText(`${'a'.repeat(RUN_SCRIPT_MAX_CHARS)}\n`, 'sh')).toBeNull()
  })

  it.each([
    ['no block', `${RUN_PREFIX}\n\nnothing`],
    ['text before', `Please ${RUN_PREFIX}\n\n\`\`\`sh\necho hi\n\`\`\``],
    ['text after the block', `${RUN_PREFIX}\n\n\`\`\`sh\necho hi\n\`\`\`\nand then more`],
    ['text between the line and the block', `${RUN_PREFIX}\n\nsure\n\`\`\`sh\necho hi\n\`\`\``],
    ['two blocks', `${RUN_PREFIX}\n\n\`\`\`sh\necho a\n\`\`\`\n\n\`\`\`sh\necho b\n\`\`\``],
    ['a fence too short for the script', `${RUN_PREFIX}\n\n\`\`\`sh\necho hi\n\`\`\`\nrm x\n\`\`\`\n\`\`\``],
    ['not closed', `${RUN_PREFIX}\n\n\`\`\`sh\necho hi\n`],
    ['closed by a shorter fence', `${RUN_PREFIX}\n\n\`\`\`\`sh\necho hi\n\`\`\``],
    ['a trailing line break after the close', `${RUN_PREFIX}\n\n\`\`\`sh\necho hi\n\`\`\`\n`],
    ['a language that is not a shell', `${RUN_PREFIX}\n\n\`\`\`python\nprint(1)\n\`\`\``],
    ['an info string with more words', `${RUN_PREFIX}\n\n\`\`\`sh title\necho hi\n\`\`\``],
    ['a blank script', `${RUN_PREFIX}\n\n\`\`\`sh\n\n\`\`\``],
    ['a different first line', `Run this:\n\n\`\`\`sh\necho hi\n\`\`\``],
    ['one blank line too few', `${RUN_PREFIX}\n\`\`\`sh\necho hi\n\`\`\``],
    ['a tilde fence', `${RUN_PREFIX}\n\n~~~sh\necho hi\n~~~`],
    ['hidden characters in the script', `${RUN_PREFIX}\n\n\`\`\`sh\necho a‮b\n\`\`\``],
    ['a return in the script', `${RUN_PREFIX}\n\n\`\`\`sh\necho a\r\necho b\n\`\`\``],
  ])('does not read %s as a Run', (_n, text) => {
    expect(parseRun(text)).toEqual({ ok: false })
  })
})

describe('the plain-bytes rule', () => {
  it('printable ASCII with line feeds and tabs is plain', () => {
    expect(isPlainRunScript('echo "a b"\n\tls -la | wc -l\n')).toBe(true)
  })
  it.each([
    ['a Cyrillic letter that looks Latin', 'echo аdmin\n'],
    ['a non-breaking space', 'echo hi\n'],
    ['an ideographic space', 'echo　hi\n'],
    ['a full-width letter', 'echo ａ\n'],
    ['an accent', 'echo café\n'],
    ['a carriage return', 'echo a\r\n'],
    ['an emoji', 'echo \u{1F600}\n'],
  ])('%s is not', (_n, script) => {
    expect(isPlainRunScript(script)).toBe(false)
  })
})

describe('one tap or two: plain, at most 6 lines and 300 characters', () => {
  const lines = (n: number) => 'echo a\n'.repeat(n) // n lines, each ending in a line break
  const chars = (n: number) => `${'a'.repeat(n - 1)}\n` // one line of exactly n characters, line break included

  it('6 lines is one tap, 7 is two; a trailing line break is not a line', () => {
    expect(isOneTapRunScript(lines(1))).toBe(true)
    expect(isOneTapRunScript(lines(6))).toBe(true)
    expect(isOneTapRunScript(lines(7))).toBe(false)
    expect(isOneTapRunScript('echo a\necho b')).toBe(true) // two lines, no final break
    expect(isOneTapRunScript(`${'echo a\n'.repeat(6)}\n`)).toBe(false) // a blank line after six is a seventh
  })

  it('300 characters is one tap, 301 is two', () => {
    expect(chars(300).length).toBe(300)
    expect(isOneTapRunScript(chars(300))).toBe(true)
    expect(isOneTapRunScript(chars(301))).toBe(false)
  })

  it('short and plain is not enough if it is not plain ASCII', () => {
    expect(isOneTapRunScript('echo caf\u00e9\n')).toBe(false)
    expect(isOneTapRunScript('echo\u00a0hi\n')).toBe(false)
  })

  it('a script over the limit for any Run has no message at all', () => {
    expect(runText(`${'a'.repeat(RUN_SCRIPT_MAX_CHARS)}\n`, 'sh')).toBeNull()
    expect(runText(chars(301), 'sh')).not.toBeNull() // longer than one tap, still a Run
  })
})

describe('blank-looking characters are hidden characters', () => {
  it.each([
    ['a braille blank', '\u2800'],
    ['a shorthand format letter', '\u{1bca0}'],
    ['a hangul filler', '\u3164'],
    ['a half-width hangul filler', '\uffa0'],
  ])('%s makes the script no Run', (_n, ch) => {
    expect(runText(`echo a${ch}b\n`, 'sh')).toBeNull()
  })
})

describe('the block a Run is for', () => {
  const id = 'm_01JBF3V7Q8K2M4N6P8R0S1T2V3'
  it('is a message id and a place in it, and the seen-store key is built from both', () => {
    expect(RunBlockRef.safeParse({ message_id: id, index: 0 }).success).toBe(true)
    expect(runBlockKey({ message_id: id, index: 2 })).toBe(`run:${id}:2`)
    expect(runBlockKey({ message_id: id, index: 0 })).not.toBe(runBlockKey({ message_id: id, index: 1 }))
  })
  it.each([
    ['a negative place', { message_id: id, index: -1 }],
    ['a fractional place', { message_id: id, index: 1.5 }],
    ['a place that is not a number', { message_id: id, index: '1' }],
    ['an id that is not a message id', { message_id: 'x', index: 0 }],
    ['an extra field', { message_id: id, index: 0, more: 1 }],
    ['no place', { message_id: id }],
  ])('refuses %s', (_n, v) => {
    expect(RunBlockRef.safeParse(v).success).toBe(false)
  })
})

describe('the frame', () => {
  const base = {
    v: 1,
    type: 'message',
    id: '01JBF3V7Q8K2M4N6P8R0S1T2V3',
    ts: '2026-10-28T15:00:00.000Z',
    thread_id: 'general',
    client_msg_id: 'm_01JBF3V7Q8K2M4N6P8R0S1T2V3',
    text: 'x',
    attachments: [],
    device_id: `d_${'a'.repeat(20)}`,
    osig: 'a'.repeat(86),
  }
  it('carries intent run, and nothing else as an intent', () => {
    const r = MessageFrame.safeParse({ ...base, intent: 'run' })
    expect(r.success ? [] : r.error.issues).toEqual([])
    expect(MessageFrame.safeParse({ ...base, intent: 'what_did_i_miss' }).success).toBe(true)
    expect(MessageFrame.safeParse({ ...base, intent: 'RUN' }).success).toBe(false)
    expect(MessageFrame.safeParse({ ...base, intent: 'run ' }).success).toBe(false)
  })
  it('carries run_block, and refuses a malformed one', () => {
    const ok = MessageFrame.safeParse({
      ...base,
      intent: 'run',
      run_block: { message_id: base.client_msg_id, index: 3 },
    })
    expect(ok.success).toBe(true)
    expect(MessageFrame.safeParse({ ...base, intent: 'run', run_block: { message_id: 'x', index: 3 } }).success).toBe(
      false,
    )
  })
  it('a Run is good for a day', () => {
    expect(RUN_MAX_AGE_MS).toBe(86_400_000)
  })
})
