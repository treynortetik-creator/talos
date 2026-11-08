// The Calendar Apps Script (spec 7.6), shipped as a template. Like the Gmail script, the rendered text holds a one-time
// claim code and never a live signing secret. `claim_` and `post_` are inlined (the spec shows them as shorthand), and each
// changed/invite item also carries `version` (the state hash) so the normalizer can build a dedup key per change.
import { jsLiteral } from '../gmail/apps-script.ts'

const TEMPLATE = `/** Talos Calendar: your calendar changes → your Talos relay. Paste into a new Apps Script project, Run ▸ install. */
const TALOS = {
  HOOK_URL: '{{HOOK_URL}}', // https://<host>/hook/gcal/<connection_id>
  CLAIM_CODE: '{{CLAIM_CODE}}', // single use; useless after install
  DAYS_AHEAD: 14,
  STARTING_MIN: 15,
  MAX_EVENTS: 80,
}
function install() {
  claim_()
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t))
  ScriptApp.newTrigger('sync').forUserCalendar(Session.getActiveUser().getEmail()).onEventUpdated().create()
  ScriptApp.newTrigger('sync').timeBased().everyMinutes(5).create()
  run_(true) // first run records state silently
  console.log('Talos: installed.')
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
/** Trigger handler. Apps Script passes an event object to every trigger handler: never treat it as a flag. */
function sync() {
  run_(false)
}
function run_(silent) {
  const lock = LockService.getScriptLock()
  if (!lock.tryLock(5000)) return
  try {
    const p = PropertiesService.getScriptProperties()
    const secret = p.getProperty('TALOS_SECRET')
    if (!secret) throw new Error('Talos: not installed. Run install.')
    const prev = JSON.parse(p.getProperty('TALOS_STATE') || '{}') // key -> [hash, startEpochMin, startingSent]
    const now = Date.now(),
      end = now + TALOS.DAYS_AHEAD * 864e5
    const events = CalendarApp.getDefaultCalendar().getEvents(new Date(now), new Date(end)).slice(0, TALOS.MAX_EVENTS)
    const lastStart = events.length === TALOS.MAX_EVENTS ? events[events.length - 1].getStartTime().getTime() : end
    const md5 = (s) => Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s))
    const next = {},
      items = []
    events.forEach((e) => {
      const start = e.getStartTime().getTime()
      const key = md5(e.getId() + '|' + start).slice(0, 12) // getId() is the iCalUID, shared by every instance of a recurring event
      const h = md5([e.getTitle(), start, e.getEndTime().getTime(), e.getLocation(), e.getMyStatus()].join('|')).slice(
        0,
        10,
      )
      const old = prev[key]
      const info = {
        event_key: key,
        event_id: e.getId(),
        version: h,
        title: e.getTitle(),
        start: e.getStartTime().toISOString(),
        end: e.getEndTime().toISOString(),
        location: e.getLocation(),
        status: String(e.getMyStatus()),
        organizer: (e.getCreators() || [])[0] || '',
      }
      let startingSent = old ? old[2] : 0
      if (!old && String(e.getMyStatus()) === 'INVITED') items.push(Object.assign({ change: 'invite' }, info))
      else if (old && old[0] !== h) items.push(Object.assign({ change: 'changed' }, info))
      if (!startingSent && start > now && start - now <= TALOS.STARTING_MIN * 6e4) {
        items.push(Object.assign({ change: 'starting' }, info))
        startingSent = 1
      }
      next[key] = [h, Math.floor(start / 6e4), startingSent]
    })
    // Cancelled = known before, inside the window, not past the last fetched event (events cut by the cap aren't cancelled).
    Object.keys(prev).forEach((k) => {
      const st = prev[k][1] * 6e4
      if (!next[k] && st > now && st <= lastStart) items.push({ change: 'cancelled', event_key: k })
    })
    let json = JSON.stringify(next)
    const keys = Object.keys(next).sort((a, b) => next[b][1] - next[a][1]) // farthest first
    while (json.length >= 8500 && keys.length) {
      delete next[keys.shift()]
      json = JSON.stringify(next)
    } // 9 KB property cap
    if (!silent && items.length) {
      const code = post_(JSON.stringify({ v: 1, account: Session.getActiveUser().getEmail(), items: items }), secret)
      if (code < 200 || code >= 300) return // keep the old state: the next run sends these changes again
    }
    p.setProperty('TALOS_STATE', json) // only after a 2xx (or when there was nothing to send)
  } finally {
    lock.releaseLock()
  }
}
function post_(payload, secret) {
  const id = 'gc_' + Utilities.getUuid()
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

export type GcalScriptVars = { hookUrl: string; claimCode: string }

export function renderGcalScript(vars: GcalScriptVars): string {
  let url: URL
  try {
    url = new URL(vars.hookUrl)
  } catch {
    throw new Error('hookUrl is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('hookUrl must be http(s)')
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(vars.claimCode)) throw new Error('claimCode has an unexpected shape')
  const values: Record<string, string> = { HOOK_URL: vars.hookUrl, CLAIM_CODE: vars.claimCode }
  return TEMPLATE.replace(/'\{\{(HOOK_URL|CLAIM_CODE)\}\}'/g, (_m, k: string) => jsLiteral(values[k] as string))
}
