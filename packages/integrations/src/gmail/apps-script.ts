// The Gmail Apps Script (spec 7.6), shipped as a template. The rendered text holds a one-time claim code, never a
// live signing secret. Differences from the spec text, all behaviour-neutral: the `whsec_` prefix is stripped by
// position instead of by a regex naming it (so the rendered script contains no `whsec_` at all), and the template is
// rendered by `renderGmailScript`, which escapes every value into a JS string literal.

const TEMPLATE = `/** Talos Inbox: Gmail → your Talos relay. Paste into a new Apps Script project, then Run ▸ install. */
const TALOS = {
  HOOK_URL: '{{HOOK_URL}}', // https://<host>/hook/gmail/<connection_id>
  CLAIM_CODE: '{{CLAIM_CODE}}', // single use; useless after install
  QUERY: '{{QUERY}}', // default: in:inbox category:primary
  FORWARD_LABEL: '{{FORWARD_LABEL}}', // default: Talos/Inbound ('' = off)
  EVERY_MINUTES: 5,
  PAGE: 40,
  MAX_PAGES: 5,
  CHUNK: 50,
  PREVIEW_CHARS: 300,
  FULL_CHARS: 4000,
}
function install() {
  claim_()
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'tick')
    .forEach((t) => ScriptApp.deleteTrigger(t))
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(TALOS.EVERY_MINUTES).create()
  const p = PropertiesService.getScriptProperties()
  if (!p.getProperty('TALOS_CURSOR')) p.setProperty('TALOS_CURSOR', String(Math.floor(Date.now() / 1000) - 3600))
  tick()
  console.log('Talos: installed. New mail shows up within ' + TALOS.EVERY_MINUTES + ' minutes.')
}
function uninstall() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t))
  PropertiesService.getScriptProperties().deleteAllProperties()
  console.log('Talos: removed. Delete the connection in the app too.')
}
function claim_() {
  const p = PropertiesService.getScriptProperties()
  if (p.getProperty('TALOS_SECRET')) return
  const r = UrlFetchApp.fetch(TALOS.HOOK_URL + '/claim', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ claim_code: TALOS.CLAIM_CODE }),
    muteHttpExceptions: true,
  })
  if (r.getResponseCode() !== 200)
    throw new Error('Talos: claim failed (' + r.getResponseCode() + '). Make a fresh script in the app.')
  p.setProperty('TALOS_SECRET', JSON.parse(r.getContentText()).secret)
}
function tick() {
  const lock = LockService.getScriptLock()
  if (!lock.tryLock(5000)) return
  try {
    const p = PropertiesService.getScriptProperties()
    const secret = p.getProperty('TALOS_SECRET')
    if (!secret) throw new Error('Talos: not installed. Run install.')
    const cursor = Number(p.getProperty('TALOS_CURSOR') || 0)
    const after = ' after:' + (cursor - 120) // 2-minute overlap; the relay dedups on message_id
    const items = []
    let max = cursor,
      truncated = false
    const add = (query, full) => {
      // search returns newest first: page until a short page
      for (let page = 0; page < TALOS.MAX_PAGES; page++) {
        const threads = GmailApp.search(query + after, page * TALOS.PAGE, TALOS.PAGE)
        threads.forEach((t) => addThread(t, full))
        if (threads.length < TALOS.PAGE) return
      }
      truncated = true // >200 threads in one run: the Inbox shows "some mail was skipped"
    }
    const addThread = (t, full) => {
      t.getMessages().forEach((m) => {
        const at = Math.floor(m.getDate().getTime() / 1000)
        if (at < cursor - 120 || m.isInTrash() || m.isDraft()) return
        const body = m.getPlainBody() || ''
        items.push({
          message_id: m.getId(),
          thread_id: t.getId(),
          from: m.getFrom(),
          to: m.getTo(),
          subject: m.getSubject(),
          date: m.getDate().toISOString(),
          unread: m.isUnread(),
          starred: m.isStarred(),
          labels: t.getLabels().map((l) => l.getName()),
          forwarded: full,
          text: body.slice(0, full ? TALOS.FULL_CHARS : TALOS.PREVIEW_CHARS),
          link: 'https://mail.google.com/mail/u/0/#all/' + t.getId(),
        })
        if (at > max) max = at
      })
    }
    add(TALOS.QUERY, false)
    if (TALOS.FORWARD_LABEL) add('label:"' + TALOS.FORWARD_LABEL + '"', true)
    if (!items.length) return
    const account = Session.getActiveUser().getEmail()
    for (let i = 0; i < items.length; i += TALOS.CHUNK) {
      // ≤50 items per POST keeps bodies well under 1 MB
      const payload = JSON.stringify({
        v: 1,
        account: account,
        truncated: truncated,
        items: items.slice(i, i + TALOS.CHUNK),
      })
      const code = post_(payload, secret)
      if (code < 200 || code >= 300) {
        console.warn('Talos: relay answered ' + code + '; retrying next run.')
        return
      }
    }
    p.setProperty('TALOS_CURSOR', String(max)) // only after every chunk landed
  } finally {
    lock.releaseLock()
  }
}
function post_(payload, secret) {
  const id = 'gm_' + Utilities.getUuid()
  const ts = String(Math.floor(Date.now() / 1000))
  const key = Utilities.base64Decode(secret.slice(secret.indexOf('_') + 1)) // drop the "<prefix>_" the relay adds
  const mac = Utilities.computeHmacSignature(
    Utilities.MacAlgorithm.HMAC_SHA_256,
    Utilities.newBlob(id + '.' + ts + '.' + payload).getBytes(),
    key,
  )
  return UrlFetchApp.fetch(TALOS.HOOK_URL, {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    payload: Utilities.newBlob(payload).getBytes(),
    muteHttpExceptions: true,
    headers: { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': 'v1,' + Utilities.base64Encode(mac) },
  }).getResponseCode()
}
`

/** A JS single-quoted string literal for arbitrary text (no raw quotes, backslashes, line breaks or `</`). */
export function jsLiteral(value: string): string {
  const body = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16)}`)
    .replace(/</g, '\\x3C')
  return `'${body}'`
}

export type GmailScriptVars = {
  hookUrl: string
  claimCode: string
  /** Default `in:inbox category:primary`. */
  query?: string
  /** Default `Talos/Inbound`; '' turns forwarding off. */
  forwardLabel?: string
}

export const DEFAULT_QUERY = 'in:inbox category:primary'
export const DEFAULT_FORWARD_LABEL = 'Talos/Inbound'

export function renderGmailScript(vars: GmailScriptVars): string {
  let url: URL
  try {
    url = new URL(vars.hookUrl)
  } catch {
    throw new Error('hookUrl is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('hookUrl must be http(s)')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(vars.claimCode)) throw new Error('claimCode has an unexpected shape')
  const query = vars.query ?? DEFAULT_QUERY
  const label = vars.forwardLabel ?? DEFAULT_FORWARD_LABEL
  if (query.length > 300 || label.length > 100) throw new Error('query or forward label too long')
  const values: Record<string, string> = {
    HOOK_URL: vars.hookUrl,
    CLAIM_CODE: vars.claimCode,
    QUERY: query,
    FORWARD_LABEL: label,
  }
  return TEMPLATE.replace(/'\{\{(HOOK_URL|CLAIM_CODE|QUERY|FORWARD_LABEL)\}\}'/g, (_m, k: string) =>
    jsLiteral(values[k] as string),
  )
}

/** The unrendered template (placeholders intact). */
export const GMAIL_SCRIPT_TEMPLATE = TEMPLATE
