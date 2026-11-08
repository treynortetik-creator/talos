// How a PermissionRequest hook's tool call is put on a card (docs/CLAUDE-CODE.md C3.9). The owner approves what he can see, so
// runs of ASCII spaces and line breaks are folded to one visible marker (`⟨15000 spaces⟩`, a line break `⏎`): a call padded with
// blanks reads short, with its count on show, and the end of it is never pages below. Only ASCII spaces carry the label "spaces":
// every other blank (a no-break space, a tab, U+FEFF, a vertical tab ...) is left alone here and shown as its own [U+XXXX] marker
// by the card composer, so each label says exactly what is there.

/** ASCII spaces and the line breaks (LF, CR, U+2028, U+2029). */
const WS_RUN = /[ \n\r\u2028\u2029]+/gu
const LINEBREAK = /\n|\r(?!\n)|\u2028|\u2029/gu
const MAX_KEPT_SPACES = 8
const MAX_LINEBREAKS_SHOWN = 8

/** Every run of ASCII spaces and line breaks other than one plain space, folded: line breaks as `⏎`, short plain-space runs kept, the rest counted. */
export function foldWhitespace(input: string): string {
  return input.replace(WS_RUN, (raw) => {
    const run = raw.replace(/\r\n/gu, '\n')
    if (run === ' ') return run
    const breaks = run.match(LINEBREAK)?.length ?? 0
    const rest = run.replace(LINEBREAK, '')
    let out = breaks === 0 ? '' : breaks <= MAX_LINEBREAKS_SHOWN ? '⏎'.repeat(breaks) : `⟨${breaks} lines⟩`
    if (rest.length > 0)
      out +=
        /^ +$/.test(rest) && rest.length <= MAX_KEPT_SPACES
          ? rest
          : `⟨${rest.length} space${rest.length === 1 ? '' : 's'}⟩`
    return out
  })
}

export type HookCall = { preview: string; description: string; json: string }

/**
 * What the card binds for a hook call. Bash with only `command` (and `description`) shows the command as text; anything else
 * shows the whole input as JSON. `json` is the input as Claude Code's relay would serialise it, for matching a relayed twin.
 */
export function renderHookCall(toolName: string, toolInput: unknown): HookCall | undefined {
  let json: string | undefined
  try {
    json = JSON.stringify(toolInput ?? {})
  } catch {
    return undefined
  }
  if (typeof json !== 'string') return undefined
  const input = (typeof toolInput === 'object' && toolInput !== null ? toolInput : {}) as Record<string, unknown>
  const plainBash =
    toolName === 'Bash' &&
    typeof input.command === 'string' &&
    Object.keys(input).every((k) => k === 'command' || k === 'description')
  const body = foldWhitespace(plainBash ? (input.command as string) : json)
  const description = typeof input.description === 'string' ? foldWhitespace(input.description) : ''
  return { preview: body, description, json }
}
