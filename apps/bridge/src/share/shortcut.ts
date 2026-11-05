// `talos-app share shortcut` (docs/V2-FEATURES.md V4.3 P1): builds the iOS Shortcut that posts a share to
// `POST <relay>/api/share` with a device-bound bearer token. The recipe is exactly the one in docs/SHARE.md.
//
// UNTRUSTED BY CONSTRUCTION: the file carries a text-or-files share token and nothing else. There is no trusted or
// owner option anywhere in this module, and the relay has none to grant: a Shortcut cannot sign, so what it posts is
// always `external` Inbox data (docs/V2-FEATURES.md V4.7). The owner rejected a "trusted" token.
import { spawn } from 'node:child_process'

export type Sign = (input: string, output: string) => Promise<{ ok: true } | { ok: false; error: string }>

/** Relay limit for a token label (`ShareToken.label`). */
export const LABEL_MAX = 40

/** `<label> (exported YYYY-MM-DD)`, with the label cut so the whole thing fits the relay's 40 characters. */
export function exportLabel(label: string, day: string): string {
  const suffix = ` (exported ${day})`
  const clean = label.replace(/\s+/g, ' ').trim() || 'iPhone'
  const room = LABEL_MAX - suffix.length
  return `${cutToUnits(clean, room)}${suffix}`
}

/**
 * The longest whole-character prefix of `s` that is at most `units` UTF-16 units (the relay counts units). It cuts on
 * grapheme boundaries, so an emoji, a surrogate pair or a family sequence is never split.
 */
export function cutToUnits(s: string, units: number): string {
  if (s.length <= units) return s
  let out = ''
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) {
    if (out.length + segment.length > units) break
    out += segment
  }
  return out.trimEnd()
}

/** File-name part of a label: lower-case letters, digits and dashes only. */
export function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'share'
  )
}

// ---- a tiny XML property-list writer (no dependency; the shapes below are all we need) ------------------------------

type Plist = string | number | boolean | Plist[] | { [k: string]: Plist }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function emit(v: Plist, pad: string): string {
  if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>\n`
  if (typeof v === 'number') return `${pad}<integer>${v}</integer>\n`
  if (typeof v === 'boolean') return `${pad}<${v}/>\n`
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}<array/>\n`
    return `${pad}<array>\n${v.map((x) => emit(x, `${pad}\t`)).join('')}${pad}</array>\n`
  }
  const keys = Object.keys(v)
  if (keys.length === 0) return `${pad}<dict/>\n`
  return `${pad}<dict>\n${keys.map((k) => `${pad}\t<key>${esc(k)}</key>\n${emit(v[k] as Plist, `${pad}\t`)}`).join('')}${pad}</dict>\n`
}

export function toPlistXml(root: { [k: string]: Plist }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${emit(root, '')}</plist>\n`
}

// ---- the Shortcut ---------------------------------------------------------------------------------------------------

const OBJ = '￼' // the placeholder character a Shortcuts text field uses where a variable sits
const ASK_UUID = '6F1E3B0A-7C52-4D8E-9A41-3B2D5C7E9F10'

/** A text field that holds exactly one variable: `{ExtensionInput}` = the Shortcut Input. */
const inputAsText = (): Plist => ({
  Value: {
    string: OBJ,
    attachmentsByRange: {
      '{0, 1}': {
        Type: 'ExtensionInput',
        Aggrandizements: [{ Type: 'WFCoercionVariableAggrandizement', CoercionItemClass: 'WFStringContentItem' }],
      },
    },
  },
  WFSerializationType: 'WFTextTokenString',
})
const askOutput = (): Plist => ({
  Value: {
    string: OBJ,
    attachmentsByRange: { '{0, 1}': { Type: 'ActionOutput', OutputUUID: ASK_UUID, OutputName: 'Provided Input' } },
  },
  WFSerializationType: 'WFTextTokenString',
})
const plainText = (s: string): Plist => ({ Value: { string: s }, WFSerializationType: 'WFTextTokenString' })

const field = (key: string, value: Plist, itemType: number): Plist => ({
  WFItemType: itemType,
  WFKey: plainText(key),
  WFValue: value,
})

export type ShortcutSpec = { relayUrl: string; secret: string; files: boolean; askForNote: boolean }

/** The unsigned workflow, as an XML property list. */
export function buildShortcutPlist(spec: ShortcutSpec): string {
  const form: Plist[] = [field('text', inputAsText(), 0)]
  if (spec.files)
    form.push(
      field(
        'file',
        // a file part wants the attachment wrapped as a parameter state (the bare form is rejected by `shortcuts sign`)
        {
          Value: { Value: { Type: 'ExtensionInput' }, WFSerializationType: 'WFTextTokenAttachment' },
          WFSerializationType: 'WFTokenAttachmentParameterState',
        },
        5,
      ),
    )
  if (spec.askForNote) form.push(field('note', askOutput(), 0))

  const actions: Plist[] = []
  if (spec.askForNote)
    actions.push({
      WFWorkflowActionIdentifier: 'is.workflow.actions.ask',
      WFWorkflowActionParameters: { WFAskActionPrompt: 'Note for Talos', WFInputType: 'Text', UUID: ASK_UUID },
    })
  actions.push({
    WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
    WFWorkflowActionParameters: {
      WFURL: `${spec.relayUrl.replace(/\/+$/, '')}/api/share`,
      WFHTTPMethod: 'POST',
      WFHTTPBodyType: 'Form',
      WFHTTPHeaders: {
        Value: { WFDictionaryFieldValueItems: [field('Authorization', plainText(`Bearer ${spec.secret}`), 0)] },
        WFSerializationType: 'WFDictionaryFieldValue',
      },
      WFFormValues: {
        Value: { WFDictionaryFieldValueItems: form },
        WFSerializationType: 'WFDictionaryFieldValue',
      },
      ShowHeaders: true,
    },
  })
  actions.push({
    WFWorkflowActionIdentifier: 'is.workflow.actions.notification',
    WFWorkflowActionParameters: { WFNotificationActionTitle: 'Talos', WFNotificationActionBody: 'Sent to Talos' },
  })

  const classes = ['WFStringContentItem', 'WFURLContentItem', 'WFSafariWebPageContentItem']
  if (spec.files) classes.push('WFImageContentItem', 'WFGenericFileContentItem')
  return toPlistXml({
    WFWorkflowActions: actions,
    WFWorkflowClientVersion: '2900', // a string: `shortcuts sign` crashes on an integer here
    WFWorkflowClientRelease: '7.0',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 463140863, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowImportQuestions: [],
    WFWorkflowInputContentItemClasses: classes,
    WFWorkflowTypes: ['ActionExtension'],
    WFWorkflowHasShortcutInputVariables: true,
  })
}

// ---- signing (macOS only) -------------------------------------------------------------------------------------------

/** `shortcuts sign --mode anyone`: macOS 12+, needs the Shortcuts CLI and an iCloud sign-in. */
export const signWithShortcutsCli: Sign = (input, output) =>
  new Promise((resolve) => {
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('shortcuts', ['sign', '--mode', 'anyone', '--input', input, '--output', output], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
    } catch (e) {
      return resolve({ ok: false, error: (e as Error).message })
    }
    const timer = setTimeout(() => child.kill(), 60_000)
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim().slice(0, 300) || `exit ${code}` })
    })
  })

export const signCommand = (input: string, output: string) =>
  `shortcuts sign --mode anyone --input '${input}' --output '${output}'`

/** The by-hand steps (the same recipe as docs/SHARE.md). Never contains the secret: it goes in the recipe file. */
export function manualSteps(files: boolean): string[] {
  return [
    'Or build it by hand in the Shortcuts app (docs/SHARE.md, "iPhone: build the Shortcut"):',
    '  1. New shortcut, turn on Show in Share Sheet, Receive Text, URLs, Safari web pages' +
      `${files ? ', Images and Files' : ''} from Share Sheet.`,
    '  2. (optional) Ask for Input: "Note for Talos".',
    '  3. Get Contents of URL: <relay>/api/share, Method POST, header Authorization = Bearer <key>, Request Body Form:',
    `     text = Shortcut Input (as text)${files ? ', file = Shortcut Input' : ''}, note = Provided Input.`,
    '  4. Show Notification: "Sent to Talos".',
  ]
}
