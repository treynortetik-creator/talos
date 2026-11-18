// The screen tools: a session sees and drives the Mac's screen through Talos.app's own screen helper (../screen.ts), never
// through Claude Code's built-in computer use, which every Talos session has denied. Main and thread sessions get them;
// headless jobs do not. Each answers at once: a screenshot as an image, or one sentence saying what happened or why not.

import type { BridgeContext } from '../context.ts'
import { refusalText, type ScreenAnswer, screenTransport } from '../screen.ts'
import { askOwnerText } from '../screen-consent.ts'
import { fail, ok, type ToolResult } from './common.ts'
import { type ToolRecord, WORKER_NO_THREAD } from './define.ts'

/** Tests replace the transport (one object, shared with the consent cards). */
export { screenTransport }

const base = { group: 'screen', headless: false, ...WORKER_NO_THREAD, instructions: null, told: [] } as const

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

async function send(ctx: BridgeContext, req: Record<string, unknown>): Promise<ScreenAnswer> {
  return await screenTransport.request(ctx, req)
}

/**
 * A refusal, in one sentence. An app the Mac measured and found off the list is put to the owner as a card (once per app per
 * Mac); the agent is told at once that the owner was asked, and never waits for the answer.
 */
async function refused(ctx: BridgeContext, a: Extract<ScreenAnswer, { ok: false }>): Promise<ToolResult> {
  if (a.code === 'app_not_allowed' && a.ask) return fail(await askOwnerText(ctx, a))
  return fail(refusalText(a))
}

const point = { x: { type: 'number' }, y: { type: 'number' } }

export const screenShot: ToolRecord = {
  ...base,
  name: 'screen_shot',
  description:
    "Take a screenshot of this Mac's screen through Talos.app. Only windows of apps on this Mac's allowed list show, plus the desktop; every other window is a blank gap. No arguments: the main display. display_id: another display. region: {x, y, width, height} in screen points. The answer is the image and a line saying how its pixels map to screen points for screen_click.",
  inputSchema: {
    type: 'object',
    properties: {
      display_id: { type: 'number' },
      region: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args): Promise<ToolResult> {
    let area: Record<string, unknown> = { kind: 'full' }
    if (args.display_id !== undefined) {
      if (!num(args.display_id)) return fail('display_id must be a number. Nothing was done.')
      area = { kind: 'display', id: args.display_id }
    } else if (args.region !== undefined) {
      const r = args.region as Record<string, unknown> | null
      if (!r || !num(r.x) || !num(r.y) || !num(r.width) || !num(r.height))
        return fail('region needs x, y, width and height as numbers. Nothing was done.')
      area = { kind: 'region', x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const a = await send(ctx, { op: 'shot', area })
    if (!a.ok) return refused(ctx, a)
    const b = a.body
    const png = b.png_base64
    const at = b.area as Record<string, unknown> | undefined
    if (
      typeof png !== 'string' ||
      png === '' ||
      !num(b.width) ||
      !num(b.height) ||
      !at ||
      !num(at.x) ||
      !num(at.y) ||
      !num(at.width)
    )
      return fail(refusalText({ code: 'bad_answer', text: '' }))
    const scale = (at.width as number) / (b.width as number)
    const shown = Array.isArray(b.shown_apps) ? (b.shown_apps as unknown[]).filter((x) => typeof x === 'string') : []
    const hidden = num(b.hidden_windows) ? b.hidden_windows : 0
    const lines = [
      `Screenshot ${b.width}×${b.height} pixels of the screen area x ${at.x}, y ${at.y}, width ${at.width}, height ${at.height} (points).`,
      `To click a pixel (px, py): screen_click x = ${at.x} + px × ${round(scale)}, y = ${at.y} + py × ${round(scale)}.`,
      shown.length > 0 ? `Shows: ${shown.join(', ')}.` : "Shows no app's windows, only the desktop.",
    ]
    if (hidden > 0)
      lines.push(
        `${hidden} window${hidden === 1 ? ' is' : 's are'} blank: their apps aren't on this Mac's allowed list yet.`,
      )
    return {
      content: [
        { type: 'image', data: png, mimeType: 'image/png' },
        { type: 'text', text: lines.join(' ') },
      ],
    }
  },
}

const round = (n: number) => Math.round(n * 1000) / 1000

function inputTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  build: (args: Record<string, unknown>) => Record<string, unknown> | string,
  done: (args: Record<string, unknown>, body: Record<string, unknown>) => string | ToolResult,
): ToolRecord {
  return {
    ...base,
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    async handler(ctx, args): Promise<ToolResult> {
      const req = build(args)
      if (typeof req === 'string') return fail(`${req} Nothing was done.`)
      const a = await send(ctx, req)
      if (!a.ok) return refused(ctx, a)
      const r = done(args, a.body)
      return typeof r === 'string' ? ok(r) : r
    },
  }
}

export const screenClick = inputTool(
  'screen_click',
  "Click at a point on this Mac's screen (screen points, as screen_shot explains). Refused unless the app in front, and the window under the point, are on this Mac's allowed list. Talos itself can be on that list like any app, but a click or key never answers an approval card or a permission prompt. button: left (default), right or middle; count: 1-3.",
  { ...point, button: { type: 'string', enum: ['left', 'right', 'middle'] }, count: { type: 'number' } },
  ['x', 'y'],
  (a) => {
    if (!num(a.x) || !num(a.y)) return 'x and y must be numbers.'
    if (a.count !== undefined && !num(a.count)) return 'count must be a number.'
    return {
      op: 'click',
      x: a.x,
      y: a.y,
      ...(a.button ? { button: a.button } : {}),
      ...(a.count ? { count: a.count } : {}),
    }
  },
  (a) => `Clicked at ${a.x}, ${a.y}.`,
)

export const screenType = inputTool(
  'screen_type',
  'Type text into the app in front on this Mac (characters go in as key presses). A newline in the text IS the Return key: it submits forms, sends messages and runs commands, so only include one when you mean to press Return. Refused unless that app is on this Mac\'s allowed list; if another app comes to the front mid-way, typing stops there. The reply says whether the text was checked: "verified" means the field now shows it; "could not verify" means this app\'s text can\'t be read (or the text included Return, which may have cleared the field), so the text may NOT have landed (look with screen_shot before relying on it); "did not land" is an error: the field did not change.',
  { text: { type: 'string', maxLength: 10_000 } },
  ['text'],
  (a) => (typeof a.text === 'string' && a.text !== '' ? { op: 'type', text: a.text } : 'text is required.'),
  (a, body) => {
    const n = [...String(a.text)].length
    // an old Mac app sends no read_back: the same as a field that cannot be read. Never a bare "Typed N".
    if (body.read_back === 'verified') return `Typed ${n} characters and verified: the field now shows them.`
    if (body.read_back === 'unchanged')
      return fail(
        `Typing did not land: the field is the same after ${n} characters were sent. Click into the field with screen_click, then type again, and check with screen_shot.`,
      )
    if (body.read_back === 'unverified_return')
      return `Typed ${n} characters, could not verify: the text included Return, so the field may have been submitted or cleared. Check with screen_shot.`
    if (body.read_back === 'mismatch' && typeof body.field_suffix === 'string')
      return ok(
        `The field doesn't show the text exactly as sent (autocorrect or formatting can change it, or only part landed). It now ends with "${body.field_suffix.slice(-80)}".`,
      )
    return `Typed ${n} characters, could not verify (this app's text isn't readable). It may not have landed: check with screen_shot.`
  },
)

export const screenKey = inputTool(
  'screen_key',
  'Press a key or a shortcut in the app in front on this Mac, like "return", "cmd+s" or "cmd+shift+t". Refused unless that app is on this Mac\'s allowed list.',
  { keys: { type: 'string', maxLength: 60 } },
  ['keys'],
  (a) =>
    typeof a.keys === 'string' && a.keys !== '' ? { op: 'key', keys: a.keys } : 'keys is required, like "cmd+s".',
  (a) => `Pressed ${a.keys}.`,
)

export const screenScroll = inputTool(
  'screen_scroll',
  "Scroll at a point on this Mac's screen, in pixels: dy positive scrolls up, negative down; dx positive left. Refused unless the app in front and the window under the point are on this Mac's allowed list.",
  { ...point, dx: { type: 'number' }, dy: { type: 'number' } },
  ['x', 'y'],
  (a) => {
    if (!num(a.x) || !num(a.y)) return 'x and y must be numbers.'
    if ((a.dx !== undefined && !num(a.dx)) || (a.dy !== undefined && !num(a.dy))) return 'dx and dy must be numbers.'
    return { op: 'scroll', x: a.x, y: a.y, dx: a.dx ?? 0, dy: a.dy ?? 0 }
  },
  (a) => `Scrolled at ${a.x}, ${a.y}.`,
)

export const screenApps: ToolRecord = {
  ...base,
  name: 'screen_apps',
  description:
    "List the apps running on this Mac, and which of them are on this Mac's allowed list (the ones the screen tools may show and control).",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  async handler(ctx): Promise<ToolResult> {
    const a = await send(ctx, { op: 'apps' })
    if (!a.ok) return refused(ctx, a)
    const apps = Array.isArray(a.body.apps) ? (a.body.apps as Array<Record<string, unknown>>) : null
    if (!apps) return fail(refusalText({ code: 'bad_answer', text: '' }))
    if (apps.length === 0) return ok('No apps are running on this Mac.')
    const line = (x: Record<string, unknown>) =>
      `- ${String(x.name ?? 'an app').slice(0, 80)}${typeof x.bundle_id === 'string' ? ` (${x.bundle_id.slice(0, 200)})` : ''}${x.allowed === true ? ': allowed' : ''}`
    return ok(['Apps running on this Mac:', ...apps.map(line)].join('\n'))
  },
}

export const screenOpenApp = inputTool(
  'screen_open_app',
  "Open (or bring to the front) an app on this Mac by its bundle id, like com.apple.TextEdit. Refused unless it is on this Mac's allowed list.",
  { bundle_id: { type: 'string', maxLength: 255 } },
  ['bundle_id'],
  (a) =>
    typeof a.bundle_id === 'string' && a.bundle_id !== ''
      ? { op: 'open_app', bundle_id: a.bundle_id }
      : 'bundle_id is required.',
  (a) => `Opened ${a.bundle_id}.`,
)

export const SCREEN_TOOL_RECORDS: readonly ToolRecord[] = [
  screenShot,
  screenClick,
  screenType,
  screenKey,
  screenScroll,
  screenApps,
  screenOpenApp,
]
