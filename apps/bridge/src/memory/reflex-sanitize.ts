import { neutralizeControlTags } from '@talos-app/protocol'

// A note's title and description are text somebody wrote (a message, a web page, an email, a transcript), and a pointer shows them to
// the agent. This is the TypeScript twin of kit/hooks/_talos_defuse.py `defuse`;
// test/memory-reflex-parity.test.ts keeps them equal. One line goes through, in this order, and the result is the same when it goes
// through again:
//   1. white space collapsed to single spaces (so no order hides across a line break), then invisible characters removed (control,
//      zero-width, bidi, tag-block, ...), then white space collapsed again;
//   2. fake control tags neutralised (their `<` becomes `‹`): the harness's own tags, tool-call and role tags, `<name-with-dash/>`;
//   3. a line that reads like an order to the model gets the FLAG prefix (the text is kept: it is evidence, not a command);
//   4. the protocol's own neutralizeControlTags over the result, which also sees a bracket look-alike, a homoglyph or a hidden
//      character inside a tag. `defuseNote` is steps 1 to 4, a last white space pass, and the `===` rewrite.
// The patterns are ASCII-only (no `u` flag), as the python ones are (re.ASCII), so a letter such as e-acute behaves alike.
export const FLAG = '[flagged: instruction-like text in source]'
const LT = '\u2039'

// python's str.split() white space
const WS = String.raw`\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`
const INVISIBLE = new RegExp(
  '[\\x00-\\x1f\\x7f-\\x9f\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f' +
    '\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufffb\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}]',
  'gu',
)
const TAG_NAMES = [
  'system-reminder',
  'channel',
  'cross-session-message',
  'function_calls',
  'function_results',
  'invoke',
  'parameter',
  'task-notification',
  'teammate-message',
  'tool_use_error',
  'user-prompt-submit-hook',
  'system',
  'assistant',
  'human',
  'user',
  'tool_use',
  'tool_call',
  'tool_result',
  'thinking',
  'untrusted-content',
  'bash-input',
  'bash-stdout',
  'bash-stderr',
]
const NAMES = `${TAG_NAMES.map((n) => n.replace(/[-_]/g, '[-_]')).join('|')}|(?:scheduled|command|local[-_]command)[-_][\\w-]+|antml:[\\w:.-]+|[\\w-]*[-_]hook`
const AFTER = `(?=\\s*/?\\s*(?:${NAMES})(?=[\\s/>&]|$))`
const TAG = new RegExp(`(?:<|&lt;|&#0*60;|&#x0*3c;)${AFTER}`, 'gi')
const TEMPLATE = /<(?=\|[^|<>\n]{1,40}\|>)/g
const SELFCLOSE = /<(?=[A-Za-z][\w.]*[-:_][\w:.-]*(?:\s[^<>]*)?\/>)/g
const ORDERS = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,25}\b(?:previous|prior|above|earlier|preceding|all)\b[^.\n]{0,25}\b(?:instructions?|prompts?|rules|directions?|context)\b/i,
  /\bforget (?:everything|all|what) (?:you|i|we)\b/i,
  /\byou are now\b/i,
  /\bnew (?:system )?instructions\b/i,
  /^\s*(?:[#>*\-\s]*)(?:system|assistant|developer)\s*:/i,
  /\bfrom now on,? you\b/i,
  /\bact as (?:if you (?:are|were)|an? (?:unrestricted|jailbroken))\b/i,
  /\b(?:reveal|print|show|repeat) (?:your|the) (?:system )?prompt\b/i,
  /<<\s*SYS\s*>>|\[INST\]/i,
]

/** NFKC, but only for a character that folds to ONE ASCII character: a full-width `＜channel＞` is the tag it spells, `…` stays `…`. */
function fold(text: string): string {
  if (![...text].some((c) => (c.codePointAt(0) as number) > 127)) return text // all ASCII: nothing to fold
  let out = ''
  for (const c of text) {
    let ch = c
    if ((c.codePointAt(0) as number) > 127 && !/\p{No}/u.test(c)) {
      const n = c.normalize('NFKC')
      if (n.length === 1 && n.charCodeAt(0) < 128) ch = n
    }
    out += ch
  }
  return out
}

/** Step 1: white space, then everything that draws nothing, then white space again. */
export function clean(text: string): string {
  const ws = new RegExp(`[${WS}]+`)
  const one = (t: string) => t.split(ws).filter(Boolean).join(' ')
  return one(one(text).replace(INVISIBLE, ''))
}

/** Steps 1 to 3. */
export function sanitizeNote(text: string): string {
  let t = fold(clean(text))
  for (let i = 0; i < 16; i++) {
    const u = t.replace(TAG, LT).replace(TEMPLATE, LT).replace(SELFCLOSE, LT)
    if (u === t) break
    t = u
  }
  if (!t.trimStart().startsWith(FLAG) && ORDERS.some((p) => p.test(t))) t = `${FLAG} ${t}`
  return t
}

const MARK = '[\\u0300-\\u036f\\u1ab0-\\u1aff\\u1dc0-\\u1dff\\u20d0-\\u20ff\\ufe20-\\ufe2f]*'
/** A zero-width space between EVERY `=` of any run of three or more (a combining mark after an `=` looked through): the hook's `as_data`. */
export function equalsRuns(text: string): string {
  return text.replace(new RegExp(`(?:=${MARK}){3,}`, 'gu'), (run) =>
    (run.match(new RegExp(`=${MARK}`, 'gu')) ?? []).join('\u200b'),
  )
}

/** Steps 1 to 4, a last white space pass, and the `===` rewrite: exactly what the python hook's `defuse` gives. */
export function defuseNote(text: string): string {
  return equalsRuns(clean(neutralizeControlTags(sanitizeNote(text))))
}
