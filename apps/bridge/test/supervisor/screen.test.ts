// The screen readers against the Mac's real Claude Code captures (apps/desktop/Tests/Fixtures; their READMEs say where each
// came from), and the auto-confirm guard condition by condition.
import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  type AutoConfirmInputs,
  boxText,
  channelsInArgv,
  classify,
  claudeIsReady,
  type DevChannels,
  decideAutoConfirm,
  draftPresent,
  inputBox,
  isFrameRule,
  liveDevChannels,
  liveDialog,
  resumeMissing,
  type Screen,
  stripEscapes,
} from '../../src/supervisor/screen.ts'

const FIX = resolve(import.meta.dir, '../../../desktop/Tests/Fixtures')
const rows = (path: string) => readFileSync(resolve(FIX, path), 'utf8').split('\n')
const DEV = rows('real-dev-channels/dev-channels-capture.txt')

describe('the real captures (Claude Code 2.1.318)', () => {
  const dialogs: Record<string, Screen['kind']> = {
    'bypass-disclaimer.txt': 'bypass_disclaimer',
    'login-not-logged-in.txt': 'login_expired',
    'mcp-consent.txt': 'mcp_consent',
    'trust-dialog-tcap.txt': 'trust',
    'trust-dialog.txt': 'trust',
  }
  const ready = new Set([
    'after-esc.txt',
    'draft-input.txt',
    'empty-input.txt',
    'idle-input-auto.txt',
    'idle-input-manual.txt',
    'reply-quotes-prompt.txt',
    'turn-done.txt',
  ])
  // the input-e-* captures keep their colour escapes, for the Mac's colour check; they are not plain screens
  const names = readdirSync(resolve(FIX, 'real-2.1.318')).filter((f) => f.endsWith('.txt') && !f.startsWith('input-e-'))

  it('found the captures', () => expect(names.length).toBeGreaterThan(30))
  for (const name of names)
    it(`${name}: ${dialogs[name] ?? 'no known dialog'}${ready.has(name) ? ', ready for typing' : ''}`, () => {
      const r = rows(`real-2.1.318/${name}`)
      expect(liveDialog(r).kind).toBe(dialogs[name] ?? 'none')
      expect(claudeIsReady(r)).toBe(ready.has(name))
      expect(liveDevChannels(r)).toBe(false)
    })

  it('the input box holds what was typed; a placeholder reads as text (only colours tell it apart)', () => {
    expect(boxText(rows('real-2.1.318/draft-input.txt'))).toBe('hello draft')
    expect(boxText(rows('real-2.1.318/empty-input.txt'))).toBe('')
    expect(boxText(rows('real-2.1.318/bash-permission.txt'))).toBeNull()
  })
  it('the colour-escaped input captures all have an input box once the escapes are stripped', () => {
    const esc = readdirSync(resolve(FIX, 'real-2.1.318')).filter((f) => f.startsWith('input-e-'))
    expect(esc.length).toBeGreaterThan(10)
    for (const n of esc) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the escapes are what is stripped
      const plain = rows(`real-2.1.318/${n}`).map((r) => r.replace(/\x1b\[[0-9;]*m/g, ''))
      expect(inputBox(plain)).not.toBeNull()
    }
  })
  it('a permission prompt or the agent’s own question is never one of the known dialogs', () => {
    for (const n of [
      'bash-permission.txt',
      'perm-askuserquestion.txt',
      'perm-dangerous-rm-bypass.txt',
      'write-permission.txt',
    ])
      expect(classify(rows(`real-2.1.318/${n}`)).kind).toBe('unknown_selection')
  })
})

describe('the development-channels warning', () => {
  it('the real capture is read exactly, and is live', () => {
    expect(classify(DEV)).toEqual({
      kind: 'dev_channels',
      dev: {
        channels: ['server:talos-app'],
        highlighted: 'I am using this for local development',
        titleCount: 1,
        channelsRowCount: 1,
      },
    })
    expect(liveDevChannels(DEV)).toBe(true)
    expect(claudeIsReady(DEV)).toBe(false)
  })
  it('after Down the highlight is on Exit', () => {
    const down = DEV.map((r) => r.replace('❯ 1.', '  1.').replace('  2. Exit', '❯ 2. Exit'))
    const s = classify(down)
    expect(s.kind === 'dev_channels' && s.dev.highlighted).toBe('Exit')
  })
  it('the title without a cursor is what an answered warning leaves (or a quote): not the dialog', () => {
    const answered = DEV.map((r) => r.replace('❯', ' '))
    expect(classify(answered).kind).toBe('none')
    expect(liveDevChannels(answered)).toBe(false)
  })
  it('two cursor rows in the warning are not the live warning (nor a highlight to confirm)', () => {
    const two = DEV.map((r) => r.replace('  2. Exit', '❯ 2. Exit'))
    expect(liveDevChannels(two)).toBe(false)
    const s = classify(two)
    expect(s.kind === 'dev_channels' && s.dev.highlighted).toBeNull()
  })
  it('anything below the footer means it is not live', () => {
    expect(liveDevChannels([...DEV.filter((r) => r.trim() !== ''), 'more output'])).toBe(false)
  })
  it('a channel list Ink wrapped over two rows is joined; a dangling comma keeps an empty entry', () => {
    const at = DEV.findIndex((r) => r.includes('Channels:'))
    const wrapped = [...DEV.slice(0, at), ' Channels: server:talos-app,', ' server:other', ...DEV.slice(at + 1)]
    const s = classify(wrapped)
    expect(s.kind === 'dev_channels' && s.dev.channels).toEqual(['server:talos-app', 'server:other'])
    const dangling = [...DEV.slice(0, at), ' Channels: server:talos-app,', ...DEV.slice(at + 1)]
    const d = classify(dangling)
    expect(d.kind === 'dev_channels' && d.dev.channels).toEqual(['server:talos-app', ''])
  })
  it('a resume error on its own line is the error; a sentence that mentions it is not', () => {
    expect(resumeMissing(['No session found with ID abc'])).toBe(true)
    expect(resumeMissing(['the CLI said No session found with ID abc'])).toBe(false)
  })
  it('a frame rule is at least 10 characters, 80% box drawing', () => {
    expect(isFrameRule('─'.repeat(10))).toBe(true)
    expect(isFrameRule('─'.repeat(9))).toBe(false)
    expect(isFrameRule(`${'─'.repeat(8)}ab`)).toBe(true)
    expect(isFrameRule(`${'─'.repeat(7)}abc`)).toBe(false)
    expect(inputBox(['─'.repeat(20), '❯ hi', '─'.repeat(20)])).toEqual([1, 2])
    expect(inputBox(['─'.repeat(20), '  1. Yes', '─'.repeat(20)])).toBeNull()
  })
})

describe('the auto-confirm guard', () => {
  const dev = (over: Partial<DevChannels> = {}): DevChannels => ({
    channels: ['server:talos-app'],
    highlighted: 'I am using this for local development',
    titleCount: 1,
    channelsRowCount: 1,
    ...over,
  })
  const ok: AutoConfirmInputs = {
    enabled: true,
    isMain: true,
    enterSentThisStart: false,
    screen: dev(),
    launchChannels: ['server:talos-app'],
    sealVerified: true,
    sinceSpawnMs: 5_000,
    sinceClientKeyMs: Number.POSITIVE_INFINITY,
    startKind: 'cold',
    rateLimitOk: true,
  }
  const why = (over: Partial<AutoConfirmInputs>) => {
    const d = decideAutoConfirm({ ...ok, ...over })
    return d.confirm ? 'confirm' : d.refusal
  }

  it('confirms only when every condition holds', () => expect(why({})).toBe('confirm'))
  it('refuses each failed condition, by name', () => {
    expect(why({ enabled: false })).toBe('disabled')
    expect(why({ isMain: false })).toBe('not_main')
    expect(why({ enterSentThisStart: true })).toBe('already_confirmed_this_start')
    expect(why({ screen: null })).toBe('no_dialog')
    expect(why({ screen: dev({ titleCount: 2 }) })).toBe('ambiguous_dialog')
    expect(why({ screen: dev({ channelsRowCount: 2 }) })).toBe('ambiguous_dialog')
    expect(why({ screen: dev({ channels: ['server:talos-app', 'server:evil'] }) })).toBe('channels_mismatch')
    expect(why({ screen: dev({ channels: ['server:talos-app', 'server:talos-app'] }) })).toBe('channels_mismatch')
    expect(why({ screen: dev({ channels: null }) })).toBe('channels_mismatch')
    expect(why({ launchChannels: ['server:talos-app', 'server:other'] })).toBe('channels_mismatch')
    expect(why({ launchChannels: [] })).toBe('channels_mismatch')
    expect(why({ screen: dev({ highlighted: 'Exit' }) })).toBe('wrong_highlight')
    expect(why({ screen: dev({ highlighted: null }) })).toBe('wrong_highlight')
    expect(why({ sealVerified: false })).toBe('launch_changed')
    expect(why({ sinceSpawnMs: 60_001 })).toBe('outside_window')
    expect(why({ sinceSpawnMs: -1 })).toBe('outside_window')
    expect(why({ sinceSpawnMs: Number.NaN })).toBe('outside_window')
    expect(why({ sinceClientKeyMs: null })).toBe('clients_may_be_typing')
    expect(why({ sinceClientKeyMs: 4_999 })).toBe('clients_may_be_typing')
    expect(why({ rateLimitOk: false })).toBe('rate_limited')
  })
  it('compares bytes, not canonical equivalence: a decomposed é is another channel and another row', () => {
    const composed = 'server:talos-app\u00e9'
    const decomposed = 'server:talos-appe\u0301'
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC')) // control: the same text to a reader
    const confirmRow = 'I am using this for local development'
    expect(why({ screen: dev({ highlighted: `${confirmRow}\u0301` }) })).toBe('wrong_highlight')
    expect(why({ screen: dev({ highlighted: confirmRow.normalize('NFD') }) })).toBe('confirm') // ASCII: NFD changes nothing
    const nfdChannel = 'server:talos-app'.replace('a', 'a\u0300').normalize('NFC')
    expect(why({ screen: dev({ channels: [nfdChannel] }) })).toBe('channels_mismatch')
    expect(why({ launchChannels: [nfdChannel] })).toBe('channels_mismatch')
  })
  it('reads the launch’s channels from every form of the flag, one argv element per channel', () => {
    const f = '--dangerously-load-development-channels'
    expect(channelsInArgv(['--resume', 'x', f, 'server:talos-app', '--model', 'opus'])).toEqual(['server:talos-app'])
    expect(channelsInArgv([`${f}=server:a`, f, 'server:b', 'server:c'])).toEqual(['server:a', 'server:b', 'server:c'])
    expect(channelsInArgv([f, 'server:talos-app,server:evil'])).toEqual(['server:talos-app,server:evil'])
    expect(channelsInArgv(['server:talos-app'])).toEqual([])
  })
})

// P3d3: the pointer is never typed onto the owner's draft. The plain text of the idle placeholder and of a draft can be the same,
// so the colours decide (`capture-pane -e`): dim text and the one reverse-video cursor cell are the placeholder, anything at
// normal intensity is the owner's. The same real captures the Mac's InputBoxAttributesTests read.
describe('a draft in the input box, by its colours', () => {
  const R = 'real-2.1.318'
  it('the real captures say whether there is a draft, the one that reads like the placeholder too', () => {
    for (const [name, draft] of [
      ['input-e-idle-placeholder', false],
      ['input-e-real-draft', true],
      ['input-e-draft-looks-like-placeholder', true],
      ['input-e-cleared', false],
    ] as const)
      expect([name, draftPresent(rows(`${R}/${name}.txt`))]).toEqual([name, draft])
  })
  it('every theme: its placeholder is none, its draft is one', () => {
    for (const theme of ['auto', 'dark-ansi', 'dark-cb', 'light', 'light-ansi', 'light-cb']) {
      expect([theme, draftPresent(rows(`${R}/input-e-theme-${theme}-placeholder.txt`))]).toEqual([theme, false])
      expect([theme, draftPresent(rows(`${R}/input-e-theme-${theme}-draft.txt`))]).toEqual([theme, true])
    }
  })
  it('the placeholder and the draft like it have the same plain text: only the colours can tell', () => {
    const plain = (n: string) =>
      rows(`${R}/${n}.txt`)
        .map(stripEscapes)
        .find((r) => r.startsWith('\u276F\u00A0'))
        ?.trim()
    expect(plain('input-e-draft-looks-like-placeholder')).toBe('\u276F\u00A0Try "fix lint errors"')
  })
  it('captures without colours: an empty box is no draft, typed text is; no box at all is null', () => {
    for (const n of ['empty-input', 'turn-done', 'after-esc'])
      expect([n, draftPresent(rows(`${R}/${n}.txt`))]).toEqual([n, false])
    expect(draftPresent(rows(`${R}/draft-input.txt`))).toBe(true)
    expect(draftPresent(['no box here'])).toBeNull()
  })
  it('a colour code it does not know counts as normal: the safe side, a pointer is never typed onto text', () => {
    const rule = '\u2500'.repeat(40)
    expect(draftPresent([rule, '\u276F\u00A0\u001b[2mTry\u001b[0m', rule])).toBe(false)
    expect(draftPresent([rule, '\u276F\u00A0\u001b[2m\u001b[31mTry\u001b[0m', rule])).toBe(true)
  })
})
