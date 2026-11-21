// Every agent must know how to show the owner things: a file, a page, a card, a spoken version. A later trim of the instruction
// text that drops one of these fails here: the shared constant must hold each word, and every text must carry the constant verbatim.
// (publish_page is in every session's tool list, main and thread alike.)
import { describe, expect, test } from 'bun:test'
import { agentInstructions, INSTRUCTIONS, WORKER_INSTRUCTIONS } from '../src/bridge.ts'
import { SHOW_OWNER_WORDS, WORKER_APP_WORDS, WORKER_THREAD_WORDS } from '../src/instructions.ts'

const MUST_SAY = ['`files`', '`publish_page`', '`card`', '`voice_text`'] as const

const apps = 'APPS TEXT'
const main: Array<[string, string]> = [
  ['INSTRUCTIONS', INSTRUCTIONS],
  ['main', agentInstructions({ worker: false, trust: false })],
  ['main with trust', agentInstructions({ worker: false, trust: true })],
  ['main with apps', agentInstructions({ worker: false, trust: false, appInstructions: apps })],
  ['main with trust and apps', agentInstructions({ worker: false, trust: true, appInstructions: apps })],
  [
    'main with the self-map',
    agentInstructions({ worker: false, trust: false, self: { bridgeDir: '/home/alex/talos-app', commit: 'abc1234' } }),
  ],
]
const worker: Array<[string, string]> = [
  ['WORKER_INSTRUCTIONS', WORKER_INSTRUCTIONS],
  ['worker', agentInstructions({ worker: true, trust: false })],
  ['worker with trust and apps', agentInstructions({ worker: true, trust: true, appInstructions: apps })],
]

describe('the shared words say how to show the owner things', () => {
  for (const word of MUST_SAY)
    test(`SHOW_OWNER_WORDS mentions ${word}`, () => {
      expect(SHOW_OWNER_WORDS).toContain(word)
    })

  test('a file goes through reply, a page through publish_page, and raw HTML is never message text', () => {
    expect(SHOW_OWNER_WORDS).toContain('`reply` with `files`')
    expect(SHOW_OWNER_WORDS).toMatch(/`publish_page`[\s\S]*owner_url/)
    expect(SHOW_OWNER_WORDS).toContain('Never paste raw HTML or a long document as message text')
  })
})

describe('every instruction text carries them verbatim', () => {
  for (const [name, text] of [...main, ...worker])
    test(`${name} includes SHOW_OWNER_WORDS`, () => {
      expect(text).toContain(SHOW_OWNER_WORDS)
      for (const word of MUST_SAY) expect(text, word).toContain(word)
    })

  for (const [name, text] of worker)
    test(`${name} includes the worker-only words`, () => {
      expect(text).toContain(WORKER_APP_WORDS)
      expect(text).toContain(WORKER_THREAD_WORDS)
    })
})
