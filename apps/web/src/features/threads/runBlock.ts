// Which code blocks in a message may get a Run button, and the exact message a tap sends.
//
// The script is read from the same parser that draws the block, so what is sent is what the block shows. The message it
// builds (protocol `runText`, the same code the Mac checks with) is parsed again here before it is trusted: it must come
// back as the Run line plus one block holding exactly the script.
import type { MessageT } from '@talos-app/protocol'
import {
  runText as buildRunText,
  isOneTapRunScript,
  RUN_LANGS,
  RUN_PREFIX,
  RUN_SCRIPT_MAX_CHARS,
} from '@talos-app/protocol'
import { parseMarkdown } from '../../lib/markdown.ts'
import { revealHidden } from '../cards/util.ts'
import type { RunContext } from './RunButton.tsx'

export type RunBlock = {
  /** The script exactly as the block shows it. */
  script: string
  lang: string
  /** The script has characters that are shown as tokens, not obeyed. */
  hidden: boolean
  /** Plain ASCII, at most 6 lines and 300 characters (protocol `isOneTapRunScript`): the one kind of script a single tap may run. */
  oneTap: boolean
  /** Why there is no Run button on a shell block, in words for the owner; undefined when it can run or is not a shell block. */
  blocked?: string
  runnable: boolean
}

/** The message a Run tap sends, or null when it would not read back as the Run line plus this one script. */
export function runText(script: string, lang: string): string | null {
  const text = buildRunText(script, lang)
  if (text === null) return null
  const [open, line, close, block, ...rest] = parseMarkdown(text)
  const ok =
    rest.length === 0 &&
    open?.type === 'paragraph_open' &&
    line?.type === 'inline' &&
    line.content === RUN_PREFIX &&
    close?.type === 'paragraph_close' &&
    block?.type === 'fence' &&
    block.content === script &&
    block.info.trim() === lang
  return ok ? text : null
}

/** One entry per `<pre>` the message draws, in order (fenced and indented blocks both draw one). */
export function runBlocks(source: string): RunBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const out: RunBlock[] = []
  for (const t of parseMarkdown(source)) {
    if (t.type === 'code_block')
      out.push({ script: t.content, lang: '', hidden: false, oneTap: false, runnable: false })
    else if (t.type === 'fence') {
      const lang = (t.info.trim().split(/\s+/)[0] ?? '').toLowerCase()
      const hidden = revealHidden(t.content) !== t.content
      const b: RunBlock = { script: t.content, lang, hidden, oneTap: isOneTapRunScript(t.content), runnable: false }
      if (RUN_LANGS.includes(lang)) {
        // A fence that was never closed runs to the end of the message (or its quote): that is not a block anyone chose to end.
        const last = lines[(t.map?.[1] ?? 1) - 1] ?? ''
        const closed =
          new RegExp(`^[\\s>]*[${t.markup[0]}]{${t.markup.length},}\\s*$`).test(last) &&
          (t.map?.[1] ?? 0) - (t.map?.[0] ?? 0) >= 2
        if (hidden) b.blocked = 'Hidden characters are shown in this block, so Run is off.'
        else if (!closed) b.blocked = 'This block never closes, so Run is off.'
        else if (t.content.length > RUN_SCRIPT_MAX_CHARS)
          b.blocked = 'This script is too long to run from here, so Run is off.'
        else if (runText(t.content, lang) === null) b.blocked = "This can't be sent as one Run message, so Run is off."
        else b.runnable = true
      }
      out.push(b)
    }
  }
  return out
}

/**
 * Where a message's blocks may get a Run button. No context (undefined) means no button. Only the agent's own messages: the
 * Mac does not check where a script came from, so the button is only ever on the agent's own words, never on text the
 * owner typed (plain here) or on a share, an event or a system row.
 */
export function runContextOf(m: MessageT): RunContext | undefined {
  return m.author === 'agent' ? { threadId: m.thread_id, messageId: m.id } : undefined
}
