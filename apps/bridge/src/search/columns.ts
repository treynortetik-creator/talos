// What goes in each FTS column for one message (docs/V2-FEATURES.md V3.1 table).
import { type MessageT, wellFormed } from '@talos-app/protocol'

export const SENTINEL_OPEN = ''
export const SENTINEL_CLOSE = ''
const SENTINELS = /[]/g

/** Sentinels already in the source are stripped, so highlight() output is unambiguous. */
export const clean = (s: string | undefined): string => wellFormed((s ?? '').replace(SENTINELS, ''))

export type Columns = { text: string; transcript: string; names: string; card: string }

/**
 * - `text`: message text (and a share's text, title and link).
 * - `transcript`: the voice note's transcript.
 * - `names`: attachment names, never a voice reply's.
 * - `card`: card and hook rows' titles and summaries; an app row's label and tool name. An app row's inputs and tool
 *   result are never indexed (MCP Apps M4.8): they live in `m.app`, which only these two fields are read from.
 */
export function columnsOf(m: MessageT): Columns {
  const isCardish = m.kind === 'event' || m.kind === 'card' || m.author === 'hook'
  const app = m.kind === 'app' && m.app ? [m.app.label, m.app.tool].filter(Boolean).map(clean).join('\n') : ''
  const body = clean(m.text)
  const share = m.share_content
    ? [m.share_content.title, m.share_content.text, m.share_content.url].filter(Boolean).map(clean).join('\n')
    : ''
  return {
    text: isCardish ? '' : [body, share].filter(Boolean).join('\n'),
    transcript: clean(m.transcript?.text),
    names: (m.attachments ?? [])
      .filter((a) => a && a.role !== 'voice_reply')
      .map((a) => clean(a.name))
      .join('\n'),
    card: isCardish ? body : app,
  }
}
