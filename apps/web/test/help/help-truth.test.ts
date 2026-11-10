// Every claim Talos Help makes is checked against the code it is about. The text is read from `content.ts`; the truth is read
// from the source of the very screen the text names. If a label is renamed, a menu item removed, or a key left unwired, this
// goes red until Help is corrected.
//
// How the checks are kept honest:
//  - A label must appear on its OWN screen: Settings sections and Mac settings tabs are cut out of the shared files
//    (sections.tsx, SettingsView.swift) and each label is looked for only in its own slice.
//  - A label is matched as a whole on-screen string (between quotes or tags), never as a fragment of a longer sentence.
//  - A shortcut must be wired: the handler it names has to be passed in, or the menu action has to do something.
//  - Every sentence in a note, a limit or a key's text needs an entry in CLAIMS with its evidence, and no entry may be stale.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ABSENT_LABELS,
  allText,
  type Block,
  blockText,
  HELP_SECTIONS,
  PLACE_NAME,
  SETUP_GUIDE,
  stripMarkers,
  type Where,
} from '../../src/features/help/content.ts'
import { HELP_PATH } from '../../src/features/help/path.ts'
import { WRITES_SYNCED_CONFIG } from '../../src/features/settings/SettingsScreen.tsx'
import { chordLabel, DEFAULT_KEYMAP } from '../../src/lib/keymap.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const WEB = join(ROOT, 'apps/web/src')
const MAC = join(ROOT, 'apps/desktop/Sources')

/** One spelling for quotes, ellipses and arrows, whitespace folded, so a label split across source lines still matches. */
const norm = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\\u\{2026\}/g, '…')
    .replace(/\\u\{2192\}/g, '→')
    .replace(/\\u\{2019\}/g, "'")
    .replace(/&rsquo;|&apos;|&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')

const walk = (d: string, ext: RegExp): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n)
    return statSync(p).isDirectory() ? walk(p, ext) : ext.test(n) ? [p] : []
  })
const read = (p: string) => norm(readFileSync(p, 'utf8'))
const rd = (rel: string) => read(join(ROOT, rel))
const corpus = (files: string[]) => files.map(read).join('\n')
const web = (...rel: string[]) => rel.map((r) => join(WEB, 'features', r))
const dir = (rel: string) => walk(join(WEB, 'features', rel), /\.tsx?$/)
const mac = (...rel: string[]) => rel.map((r) => join(MAC, r))

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The label is a whole string on screen: right after an opening quote or tag, right before a closing one. */
const hasLabel = (text: string, label: string) =>
  new RegExp(`(?:["'\`>])\\s*${esc(norm(label))}\\s*(?:["'\`<{])`).test(text)

// The Help feature's own files are excluded everywhere: a page cannot vouch for its own words.
const WEB_ALL = walk(WEB, /\.tsx?$/).filter((f) => !f.includes('/features/help/'))
const MAC_ALL = walk(MAC, /\.swift$/)
const EVERYTHING = corpus([...WEB_ALL, ...MAC_ALL])

// ---- the screens, cut apart ---------------------------------------------------------------------------------------------

/** A file cut at its section markers: `// ---- Name ----` in sections.tsx, `// MARK: Name` in Swift. */
function cut(text: string, marker: RegExp): Record<string, string> {
  const out: Record<string, string> = {}
  const hits = [...text.matchAll(marker)]
  hits.forEach((m, i) => {
    out[m[1] ?? ''] = text.slice(m.index ?? 0, hits[i + 1]?.index ?? text.length)
  })
  return out
}

const SECTIONS_TSX = cut(read(join(WEB, 'features/settings/sections.tsx')), /\/\/ ---- (\w+) -+/g)
const SETTINGS_VIEW = cut(read(join(MAC, 'TalosDesktop/SettingsView.swift')), /\/\/ MARK: (\w+)/g)
const MAC_TEXT = read(join(MAC, 'TalosDesktopCore/MacSettingsText.swift'))

/** Adds the words of every `MacSettingsText.x` a slice refers to, so a label kept in that table is found where it is used. */
function withNames(slice: string): string {
  const extra = [...slice.matchAll(/MacSettingsText\.(\w+)/g)].map(
    (m) => new RegExp(`static let ${m[1]} = "([^"]+)"`).exec(MAC_TEXT)?.[1] ?? '',
  )
  return `${slice}\n${extra.map((e) => `"${e}"`).join('\n')}`
}

const APP_SWIFT = read(join(MAC, 'TalosDesktop/App.swift'))
const SESSION_VIEW = APP_SWIFT.slice(
  APP_SWIFT.indexOf('struct SessionView'),
  APP_SWIFT.indexOf('extension SupervisorController'),
)
const MENU_BAR = APP_SWIFT.slice(
  APP_SWIFT.indexOf('MenuBarExtra {'),
  APP_SWIFT.indexOf('Window(MacSettingsText.windowTitle'),
)

/** The source of each Settings section, and of nothing else. */
const SETTINGS_TEXT: Record<string, string> = {
  Account: SECTIONS_TSX.Account ?? '',
  Notifications: `${SECTIONS_TSX.Notifications ?? ''}\n${corpus(web('pwa/NativePushRow.tsx'))}`,
  Agent: corpus(dir('agent-config')),
  Session: corpus(dir('session')),
  'Thread sessions': corpus(dir('thread-sessions')),
  Voice: corpus([...web('voice/index.tsx'), ...dir('drive')]),
  Integrations: corpus(dir('integrations')),
  'Share from other apps': corpus(dir('share')),
  Health: corpus(dir('health')),
  Appearance: SECTIONS_TSX.Appearance ?? '',
}

/** The source of each tab of the Mac settings window, and of nothing else. */
const MAC_TAB_TEXT: Record<string, string> = {
  Session: `${withNames(SETTINGS_VIEW.Session ?? '')}\n${SESSION_VIEW}`,
  Connection: `${withNames(SETTINGS_VIEW.Connection ?? '')}\n${corpus(mac('TalosDesktop/SignIn.swift'))}`,
  Permissions: corpus(mac('TalosDesktop/PermissionsView.swift', 'TalosDesktopCore/PermissionsModel.swift')),
  Hotkeys: corpus(mac('TalosDesktop/HotkeyView.swift')),
  Companion: corpus(mac('TalosDesktop/CompanionSettingsView.swift')),
  General: withNames(SETTINGS_VIEW.General ?? ''),
}

/** Each thread-settings label, with the one file that draws it. */
const THREAD_LABEL_FILE: Record<string, string> = {
  Notifications: 'threads/manage/ThreadEditor.tsx',
  'Own session': 'thread-sessions/OwnSession.tsx',
}

const SPEC = read(join(MAC, 'TalosDesktopCore/AppMenuSpec.swift'))

/** Subcommands the CLI really has: `case 'enroll':` in its dispatcher. */
const CLI = read(join(ROOT, 'apps/bridge/src/cli-main.ts'))
const CLI_COMMANDS = new Set([...CLI.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]))

/** The Mac settings tabs, read from the window's own tab list, with MacSettingsText names resolved. */
function macTabs(): string[] {
  const view = read(join(MAC, 'TalosDesktop/SettingsView.swift'))
  const named = (id: string) => new RegExp(`static let ${id} = "([^"]+)"`).exec(MAC_TEXT)?.[1]
  return [...view.matchAll(/\.tabItem \{ Label\(([^,]+),/g)].map((m) => {
    const arg = (m[1] ?? '').trim()
    const lit = /^"([^"]+)"$/.exec(arg)?.[1]
    return lit ?? named(arg.replace('MacSettingsText.', '')) ?? `??${arg}`
  })
}

// ---- the text, gathered -------------------------------------------------------------------------------------------------

type Rows = Array<{ q: string; where: Where[]; note?: string }>
const blocks = () => HELP_SECTIONS.flatMap((s) => s.blocks)
const whereRows = (): Rows => blocks().flatMap((b: Block) => (b.kind === 'where' ? b.rows : []))
const keyGroups = () => blocks().flatMap((b) => (b.kind === 'keys' ? b.groups : []))
const limitRows = () => blocks().flatMap((b) => (b.kind === 'limits' ? b.rows : []))

/** Every string of the page that can carry a marker. */
function allStrings(): string[] {
  const out: string[] = []
  for (const b of blocks()) {
    if (b.kind === 'p') out.push(b.text)
    if (b.kind === 'steps') out.push(...b.items)
    if (b.kind === 'fix') for (const r of b.rows) out.push(...r.steps)
    if (b.kind === 'where') for (const r of b.rows) if (r.note) out.push(r.note)
    if (b.kind === 'limits') for (const r of b.rows) out.push(r.a)
    if (b.kind === 'keys') for (const g of b.groups) for (const r of g.rows) out.push(r.when)
  }
  return out
}
const marked = (re: RegExp) =>
  [...allStrings().join('\n').matchAll(re)].map((m) => (m[1] ?? '').trim()).filter((x, i, a) => a.indexOf(x) === i)

// ---- one place to check a location --------------------------------------------------------------------------------------

type Place = Where['place']

/** What is wrong with a path on screen, or nothing. Used for the Where rows and for every ((path)) in the prose. */
function pathProblems(place: Place, path: string[]): string[] {
  const bad: string[] = []
  const [first, ...rest] = path
  if (place === 'settings') {
    const text = first ? SETTINGS_TEXT[first] : undefined
    if (text === undefined) return [`no Settings section "${first}"`]
    for (const l of rest) if (!hasLabel(text, l)) bad.push(`"${l}" is not on Settings → ${first}`)
  } else if (place === 'mac') {
    const text = first ? MAC_TAB_TEXT[first] : undefined
    if (text === undefined || !macTabs().includes(first ?? '')) return [`no Mac settings tab "${first}"`]
    for (const l of rest) if (!hasLabel(text, l)) bad.push(`"${l}" is not on the Mac settings ${first} tab`)
  } else if (place === 'thread') {
    for (const l of path) {
      const file = THREAD_LABEL_FILE[l]
      if (!file) bad.push(`thread settings: no file known for "${l}"`)
      else if (!hasLabel(read(join(WEB, 'features', file)), l)) bad.push(`"${l}" is not drawn by ${file}`)
    }
  } else if (place === 'menubar') {
    if (!hasLabel(MENU_BAR, first ?? '')) bad.push(`the Menu bar menu has no "${first}"`)
  } else if (place === 'topmenu') {
    const [menu, item] = path
    const at = SPEC.indexOf(`title: "${menu}"`)
    const block = at < 0 ? '' : SPEC.slice(at, SPEC.indexOf('public static', at))
    if (!block.includes(`"${item}"`)) bad.push(`top menu ${menu} has no "${item}"`)
  } else if (place === 'terminal') {
    const [cmd] = path
    const sub = (cmd ?? '').split(' ')[1]
    if (!cmd?.startsWith('talos-app') || (sub && !CLI_COMMANDS.has(sub))) bad.push(`no command "${cmd}"`)
  }
  return bad
}

const PROSE_PLACE: Record<string, Place> = { Settings: 'settings', 'Mac settings': 'mac', 'Menu bar': 'menubar' }

describe('Help names only what exists, on the screen it says', () => {
  it('every [[name]] is a whole label somewhere in the app', () => {
    const names = marked(/\[\[(.+?)\]\]/g)
    expect(names.length).toBeGreaterThan(15)
    const own = new Set(Object.values(PLACE_NAME))
    const missing = names.filter((n) => !own.has(n) && !hasLabel(EVERYTHING, n))
    expect(missing).toEqual([])
  })

  it('every {{command}} is talos-app or a talos-app subcommand the CLI has', () => {
    const cmds = marked(/\{\{(.+?)\}\}/g)
    expect(cmds.length).toBeGreaterThan(5)
    for (const c of cmds) {
      const [bin, sub] = c.split(' ')
      expect(bin, c).toBe('talos-app')
      if (sub) expect(CLI_COMMANDS.has(sub), `${c}: the CLI has ${[...CLI_COMMANDS].join(', ')}`).toBe(true)
    }
  })

  it('every Where row points at labels that its own Settings section, Mac tab, menu or command really has', () => {
    const bad: string[] = []
    for (const r of whereRows())
      for (const w of r.where) for (const p of pathProblems(w.place, w.path)) bad.push(`${r.q}: ${p}`)
    expect(bad).toEqual([])
  })

  it('every ((path)) in the prose is checked the same way, and no unchecked arrow is left in the text', () => {
    const paths = marked(/\(\((.+?)\)\)/g)
    expect(paths.length).toBeGreaterThan(8)
    const bad: string[] = []
    for (const p of paths) {
      const [head, ...rest] = p.split(' → ')
      const place = PROSE_PLACE[head ?? '']
      if (!place) {
        bad.push(`${p}: unknown start "${head}"`)
        continue
      }
      for (const m of pathProblems(place, rest)) bad.push(`${p}: ${m}`)
    }
    expect(bad).toEqual([])
    for (const s of allStrings())
      expect(s.replace(/\(\(.+?\)\)/g, ''), 'an arrow outside a ((path))').not.toContain('→')
  })

  it('a location in the wrong tab is caught: Connection labels are not on the General tab, and the reverse', () => {
    // The old test read one shared file for these tabs. These would all have passed it; each must fail now.
    expect(pathProblems('mac', ['General', 'Relay address'])).not.toEqual([])
    expect(pathProblems('mac', ['Connection', 'Show a Dock icon'])).not.toEqual([])
    expect(pathProblems('mac', ['Session', 'Start Talos when I log in'])).not.toEqual([])
    expect(pathProblems('settings', ['Appearance', 'Chat notifications'])).not.toEqual([])
    expect(pathProblems('settings', ['Account', 'Quiet hours'])).not.toEqual([])
    // and a short label must match whole: 'Stop' is not found inside 'Stop session'
    expect(hasLabel('<p>Stop session</p>', 'Stop')).toBe(false)
    expect(hasLabel('<Button>Stop</Button>', 'Stop')).toBe(true)
    // the real ones pass
    expect(pathProblems('mac', ['Connection', 'Relay address'])).toEqual([])
    expect(pathProblems('mac', ['General', 'Show a Dock icon'])).toEqual([])
  })

  it('the Settings list really has the sections Help sends people to, and Help is its last row', async () => {
    const { renderSettingsLinks } = await import('./settingsList.tsx')
    const links = await renderSettingsLinks()
    const used = new Set(
      whereRows().flatMap((r) => r.where.filter((w) => w.place === 'settings').map((w) => w.path[0])),
    )
    for (const s of used)
      expect(
        links.map((l) => l.name),
        `Settings has no "${s}" row`,
      ).toContain(s)
    expect(links.at(-1)).toEqual({ name: 'Help', href: HELP_PATH })
  })

  it('the Mac settings tabs are the six Help names', () => {
    expect(macTabs()).toEqual(['Session', 'Connection', 'Permissions', 'Hotkeys', 'Companion', 'General'])
  })
})

// ---- shortcuts ----------------------------------------------------------------------------------------------------------

/** The Mac top menu, read from the spec: title, glyph, and the action behind it. */
function topMenuItems() {
  return [...SPEC.matchAll(/Item\(\.(\w+), "([^"]+)"((?:, (?:key|shift|option): (?:"[^"]*"|true|false))*)\)/g)].map(
    (m) => {
      const opts = m[3] ?? ''
      const key = /key: "(.)"/.exec(opts)?.[1] ?? ''
      return {
        action: m[1] ?? '',
        title: m[2] ?? '',
        glyph: key
          ? `${/option: true/.test(opts) ? '⌥' : ''}${/shift: true/.test(opts) ? '⇧' : ''}⌘${key.toUpperCase()}`
          : '',
      }
    },
  )
}

/** Keys the spec sets but Help does not claim, each with the reason. */
const UNCLAIMED: Record<string, string> = {
  'Talos Help': 'macOS reserves ⇧⌘/ for its own Help search, and no test here drives real AppKit to show which wins',
}

/** A menu action is wired when AppKit gets a real selector for it, or `perform` does something for it other than `break`. */
function actionIsWired(action: string): boolean {
  const appMenu = read(join(MAC, 'TalosDesktop/AppMenu.swift'))
  if (new RegExp(`case \\.${action}:\\s*i = NSMenuItem\\(title: e\\.title, action: #selector\\(NS`).test(appMenu))
    return true
  // raw text, not `read`: the line breaks are what end a case
  const actions = readFileSync(join(MAC, 'TalosDesktop/AppMenuActions.swift'), 'utf8')
  const at = actions.indexOf('static func perform')
  const m = new RegExp(`case \\.${action}:([^\\n]*(?:\\n(?!\\s*case \\.)[^\\n]*)*)`).exec(actions.slice(at))
  const body = (m?.[1] ?? '').replace(/\/\/[^\n]*/g, '').trim()
  return body !== '' && body !== 'break'
}

/** `Button("Title")` in the Menu bar menu with the ⌘ key set right after it. */
function menuBarKeys() {
  return MENU_BAR.split(/(?=Button\()/).flatMap((part) => {
    const title = /^Button\((?:[^"]*\?\s*"[^"]*"\s*:\s*)?"([^"]+)"/.exec(part)?.[1]
    const key = /\.keyboardShortcut\("(.)"\)/.exec(part)?.[1]
    return title && key ? [{ title, glyph: `⌘${key.toUpperCase()}` }] : []
  })
}

/** Browser keys: what each Help row says it does, and the keymap entry that has to carry it. */
const BROWSER_ENTRY: Record<string, string> = {
  'Open the command palette': 'palette',
  'Open the Needs-you list': 'needsYou',
  'Open thread 1 to 9, in the order of the thread list': 'thread1',
  'Search this thread': 'findInThread',
  'Open or close the Session panel': 'sessionPanel',
  'Show the keyboard shortcuts': 'shortcuts',
  'Fold or unfold the sidebar': 'sidebar',
  'Close the side panel': 'close',
}
/** The row is typed in the message box, not a global key. */
const COMPOSER_ROWS = ['Send the message']

/** Does the one dispatcher (palette/actions.ts) do something for this entry? A `return false` case does nothing. */
function actionIsHandled(act: { kind: string; name?: string }): boolean {
  const src = read(join(WEB, 'features/palette/actions.ts'))
  const key = act.kind === 'ui' ? `case '${act.name}':` : `case '${act.kind}':`
  const at = src.indexOf(key)
  if (at < 0) return false
  return !/^case '[a-zA-Z]+':\s*return false/.test(src.slice(at).replace(/\/\/[^\n]*/g, ''))
}

/** What is wrong with a list of browser-key rows: unknown rows, rows with no chord, glyphs that are not the table's, and actions that do nothing. */
function browserKeyProblems(rows: Array<{ what: string; keys?: string }>, entryOf: Record<string, string>): string[] {
  return rows.flatMap((r) => {
    if (COMPOSER_ROWS.includes(r.what)) return []
    const id = entryOf[r.what]
    const entry = DEFAULT_KEYMAP.find((e) => e.id === id)
    if (!id || !entry) return [`"${r.what}": no keymap entry is known for it`]
    if (!entry.chord) return [`"${r.what}": ${id} has no chord, so the key does nothing`]
    if (!actionIsHandled(entry.act)) return [`"${r.what}": ${id} is in the table but its action does nothing`]
    const want = [chordLabel(entry.chord, true), chordLabel(entry.chord, false)]
    const glyphs = r.keys ?? ''
    const first = id.startsWith('thread') ? [chordLabel(entry.chord, true).replace('1', ''), 'Ctrl+'] : want
    return first.every((g) => glyphs.includes(g)) || id === 'close'
      ? []
      : [`"${r.what}": Help says ${glyphs}, the table says ${want.join(' / ')}`]
  })
}

describe('Help keyboard shortcuts are wired to real handlers', () => {
  const browserRows = () => keyGroups().find((g) => g.title === 'In a web browser on a computer')?.rows ?? []

  it('every shortcut in the Mac top menu is listed with the same glyphs, nothing else is, and each one does something', () => {
    const items = topMenuItems()
    const keyed = items.filter((i) => i.glyph)
    expect(keyed.length).toBeGreaterThanOrEqual(9) // ten before Terminals… gave up ⌘K
    const listed = keyGroups().find((g) => g.title === 'Mac app, top menu')?.rows ?? []
    for (const i of keyed) {
      if (UNCLAIMED[i.title]) {
        expect(
          listed.some((r) => norm(r.what) === norm(i.title)),
          `${i.title} is listed although it is unproven: ${UNCLAIMED[i.title]}`,
        ).toBe(false)
        continue
      }
      const row = listed.find((r) => norm(r.what) === norm(i.title))
      expect(row?.keys, `${i.title} is missing from Help or has other keys`).toBe(i.glyph)
      expect(actionIsWired(i.action), `${i.title} (${i.action}) has a key but its menu action does nothing`).toBe(true)
    }
    for (const r of listed)
      expect(
        keyed.map((k) => norm(k.title)),
        `Help lists "${r.what}", the top menu has no such key`,
      ).toContain(norm(r.what))
  })

  it('the wired-action check refuses an action whose case is just break', () => {
    expect(actionIsWired('showTerminal')).toBe(true)
    expect(actionIsWired('quit')).toBe(true)
    expect(actionIsWired('hide')).toBe(true) // AppKit selector
    expect(actionIsWired('noSuchAction')).toBe(false)
  })

  it('the Menu bar menu lists exactly the keys it really sets, each on the item that has it', () => {
    const real = menuBarKeys()
    expect(real.map((r) => r.glyph).sort()).toEqual(['⌘,', '⌘N', '⌘Q', '⌘Q', '⌘T'].sort())
    const listed = keyGroups().find((g) => g.title === 'Mac app, Menu bar menu')?.rows ?? []
    expect(listed.map((r) => r.keys).sort()).toEqual(['⌘,', '⌘N', '⌘Q', '⌘T'])
    for (const r of listed)
      expect(
        real.some((k) => k.glyph === r.keys && k.title.startsWith(r.what)),
        `${r.keys} ${r.what}: no Menu bar item of that name has that key`,
      ).toBe(true)
  })

  it('the quick-compose hotkey default, and its send and close keys, are as Help says', () => {
    expect(rd('apps/desktop/Sources/TalosDesktopCore/DesktopConfig.swift')).toContain('compose: "ctrl+opt+space"')
    expect(read(join(MAC, 'TalosDesktop/QuickCompose.swift'))).toContain('Send (⌘↩), Esc')
    const row = keyGroups()
      .flatMap((g) => g.rows)
      .find((r) => r.what === 'Quick compose' && r.keys === '⌃⌥Space')
    expect(row, 'the from-anywhere row').toBeTruthy()
  })

  it('every browser key row names a keymap entry with that chord, and the dispatcher does something for it', () => {
    expect(browserKeyProblems(browserRows(), BROWSER_ENTRY)).toEqual([])
    const keys = read(join(WEB, 'lib/keymap.ts'))
    expect(keys).toContain('`Digit${n}`')
    expect(keys).toContain("code: 'KeyK'")
    expect(keys).toContain("code: 'Backslash'")
    expect(keys).toContain("code: 'Escape', mod: false")
    // Enter and Shift+Enter in the message box are exercised in composer/enter-key.test.tsx, not matched as text here.
  })

  it('the Mac-app-only keys are marked so in the table, and the Shell only turns them on inside the Mac app', () => {
    const rows = keyGroups().find((g) => g.title === 'Mac app, the Talos window')?.rows ?? []
    expect(rows.map((r) => r.what)).toEqual(['Previous thread', 'Next thread'])
    expect(DEFAULT_KEYMAP.filter((e) => e.scope === 'mac-app').map((e) => e.id)).toEqual(['threadPrev', 'threadNext'])
    expect(read(join(WEB, 'Shell.tsx'))).toContain("detectShell() === 'desktop'")
  })

  it('a key whose action does nothing would be caught: the live-call chord is such a key today', () => {
    const call = DEFAULT_KEYMAP.find((e) => e.id === 'call')
    expect(call && actionIsHandled(call.act)).toBe(false)
    // had Help still listed ⌘⇧K, this is the failure the check exists to produce
    const withCall = [...browserRows(), { what: 'Start a live call', keys: '⌘⇧K' }]
    expect(browserKeyProblems(withCall, { ...BROWSER_ENTRY, 'Start a live call': 'call' })).toEqual([
      '"Start a live call": call is in the table but its action does nothing',
    ])
    expect(allText()).not.toContain('⌘⇧K')
  })

  it('the browser keys act only on the main screens: nothing but the Shell reads them', () => {
    const users = WEB_ALL.filter((f) => /useGlobalKeys\(/.test(read(f)) && !f.endsWith('lib/useKeyboard.ts'))
    expect(users.map((f) => f.replace(`${WEB}/`, ''))).toEqual(['Shell.tsx'])
    const app = read(join(WEB, 'App.tsx'))
    const helpRoute = app.indexOf('path={HELP_PATH}')
    const shellMount = app.indexOf('<Shell />')
    expect(helpRoute).toBeGreaterThan(0)
    expect(shellMount).toBeGreaterThan(helpRoute)
    const gateOpen = app.indexOf('<Gate>', helpRoute)
    expect(gateOpen, 'Help sits in its own route, before the Shell group').toBeGreaterThan(
      app.indexOf('</Gate>', helpRoute) - 400,
    )
  })
})

// ---- notes, limits and key text: every sentence has evidence ------------------------------------------------------------

type Proof = () => void
const has =
  (rel: string, snippet: string): Proof =>
  () =>
    expect(rd(rel), `${rel} lacks: ${snippet}`).toContain(norm(snippet))
const lacks =
  (rel: string, snippet: string): Proof =>
  () =>
    expect(rd(rel), `${rel} has: ${snippet}`).not.toContain(norm(snippet))
const S = 'apps/web/src/features/settings/sections.tsx'
const NATIVE = 'apps/web/src/features/pwa/NativePushRow.tsx'
const VOICE = 'apps/web/src/features/voice/index.tsx'
const QUIT = 'apps/desktop/Sources/TalosDesktopCore/QuitPlan.swift'
const SPEC_F = 'apps/desktop/Sources/TalosDesktopCore/AppMenuSpec.swift'
const MENU_SWIFT = 'apps/desktop/Sources/TalosDesktop/AppMenu.swift'
const THREAD_ED = 'apps/web/src/features/threads/manage/ThreadEditor.tsx'

/** Text that is not a claim: a pointer back to the row above. */
const NOT_A_CLAIM = new Set(['Same as above.'])

/** The sentences that carry a fact, each with what proves it. A sentence nobody listed here fails the next test. */
const CLAIMS: Record<string, Proof[]> = {
  // Where do I change…
  'Revoke ends that device’s access.': [has(S, 'Revoke this device?'), has(S, 'Revoking it signs you out here.')],
  'Run it on your Mac.': [has(S, 'Run <code>talos-app enroll</code> on your Mac')],
  'On a phone or computer browser, open the link it prints on that device.': [
    has(S, 'open the link on the new device'),
    has('docs/SETUP.md', 'Open the link on the phone'),
  ],
  'For the iPhone app, copy the link and paste it into the app (Paste a setup link, on its sign-in screen): opening the link on the iPhone opens Safari, which sets up a Home Screen copy instead.':
    [
      has('apps/web/src/features/auth/LoginPage.tsx', 'Paste a setup link'),
      has('docs/SETUP.md', '**in Safari on iPhone**'),
      has('docs/SETUP.md', 'Add to Home Screen'),
      // the app is associated for passkeys only (webcredentials): no applinks, so a link opened on the phone never goes to the app
      has('apps/mobile/ios/App/App/AppPush.entitlements', 'webcredentials:'),
      lacks('apps/mobile/ios/App/App/AppPush.entitlements', 'applinks'),
    ],
  'Settings → Account → Add a device gives the short version.': [has(S, 'Add a device')],
  'Alarms about your Mac or the server still come through.': [
    has(S, 'Alarms about your Mac or the server still come through.'),
  ],
  'The timezone they use is set under Settings → Agent → Timezone.': [
    has(S, 'in the timezone set under Agent'),
    has(S, 'between these times ({zone})'),
  ],
  'This changes browser notifications.': [
    has('packages/protocol/src/push.ts', 'const mode = config.notifications.show_thread_names'),
  ],
  'iPhone notifications always show General and Inbox by name and call every other thread “a thread”, whatever it is set to.':
    [
      has('apps/relay/src/core/push.ts', "const APPLE_SAFE_THREADS = new Set(['general', 'inbox'])"),
      has('apps/relay/src/core/push.ts', "show_thread_names: 'fixed_only'"),
      has(NATIVE, 'every other thread reads "a thread"'),
      // the Settings page itself says the same, not the old "never show thread names"
      has(S, 'iPhone notifications always show General and Inbox by name'),
      lacks(S, 'iPhone notifications never show thread names'),
    ],
  'The Send a test notification button is in a browser once its notifications are on, and in the iPhone app once iPhone notifications are on.':
    [
      () => {
        const browser = SECTIONS_TSX.Notifications ?? ''
        const at = browser.indexOf('Send a test notification')
        expect(browser.slice(Math.max(0, at - 700), at)).toContain("push.permission === 'granted' && !push.off")
        const native = rd('apps/web/src/features/pwa/NativePushRow.tsx')
        const n = native.indexOf('Send a test notification')
        expect(native.slice(Math.max(0, n - 500), n)).toContain("view.kind === 'on'")
      },
    ],
  'The Mac app has no test button.': [
    () => {
      const row = SECTIONS_TSX.Notifications ?? ''
      const mac = row.slice(row.indexOf('function MacBannersRow'))
      expect(mac).toContain('Banners on this Mac')
      expect(mac).not.toContain('<Button') // the row is text only: nothing to press
      expect(mac.toLowerCase()).not.toContain('test notification')
      expect(norm(corpus(MAC_ALL)).toLowerCase()).not.toContain('send a test notification')
    },
  ],
  'In a browser, a test ignores the switch and the thread rules, so it can arrive while real notifications are off.': [
    has(S, 'A test ignores the switch and thread rules above, so it can arrive while real notifications are off.'),
  ],
  'On a phone, one thread’s own settings are under Open menu, then the ⋯ beside its name.': [
    has('apps/web/src/features/phone/PhoneHeader.tsx', "'Open menu'"),
    has('apps/web/src/features/phone/PhoneChrome.tsx', '<ThreadRowWithSettings'),
    has('apps/web/src/features/threads/ThreadMoreButton.tsx', 'IconMore'),
  ],
  'On a computer they are the ⋯ button at the top of the thread.': [
    has('apps/web/src/features/threads/ThreadSettings.tsx', 'IconMore'),
  ],
  'Stop shows only while the agent is working.': [
    has('apps/web/src/features/session/SessionPanel.tsx', "const showStop = can('stop') && state.busy === true"),
  ],
  'Effort changes apply from the next message.': [
    has('apps/web/src/features/session/SessionPanel.tsx', 'Applies from the next message'),
  ],
  'It applies from your next call.': [has(VOICE, 'Applies to your next call.')],
  'Your Mac reads them with its speech command.': [has(VOICE, 'your Mac reads it with its speech command')],
  'That is a different voice from the live-call voice.': [has(VOICE, 'a different voice from the live-call voice')],
  'Both are saved on this device only.': [
    has('apps/web/src/lib/theme.ts', 'localStorage.getItem(KEY)'),
    has('apps/web/src/lib/theme.ts', 'localStorage.getItem(SIZE_KEY)'),
    has(S, 'on this device only'),
  ],
  'With tmux the agent keeps running.': [has(QUIT, 'with tmux it keeps running')],
  'Without it Talos stops the agent first, waiting at most 15 seconds.': [
    has(QUIT, "On the app's own terminal the agent is stopped first"),
    has(QUIT, 'public static let stopLimit: Double = 15'),
  ],
  'Logging out or shutting down never waits.': [
    has(QUIT, 'Logout never waits at all.'),
    has(QUIT, 'Never hold a logout.'),
  ],
  // Keyboard shortcuts
  'While Talos is the front app.': [has(MENU_SWIFT, 'the menu shows whenever Talos is the frontmost app')],
  'The top menu appears when a Talos window is open or the Dock icon is on.': [
    has(SPEC_F, '(showDockIcon || hasOpenWindow) ? .regular : .accessory'),
  ],
  'On the Terminal screen, while its tabs show.': [
    has('apps/web/src/features/terminal/TerminalScreen.tsx', "addEventListener('keydown', onKey, true)"),
    has('apps/web/src/features/terminal/TerminalScreen.tsx', '!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey'),
    has('apps/web/src/features/terminal/TerminalScreen.tsx', 'if (!hasStrip) return'),
  ],
  'Terminals… in the menu has no key: ⌘K is the command palette in the Talos window.': [
    // the Window menu item and the Talos icon's menu item both carry no key, and ⌘K is the page's search chord
    () => expect(rd(SPEC_F)).toContain(norm('Item(.showTerminal, "Terminals…"),')),
    () => expect(rd(SPEC_F)).not.toMatch(/Item\(\.showTerminal, "Terminals…"[^)]*key:/),
    () =>
      expect(rd('apps/desktop/Sources/TalosDesktop/App.swift')).not.toMatch(
        /Button\("Terminals…"\)[\s\S]{0,200}keyboardShortcut/,
      ),
    has('apps/web/src/lib/keymap.ts', "code: 'KeyK'"),
  ],
  'From any app.': [has('apps/desktop/Sources/TalosDesktop/HotKeys.swift', 'RegisterEventHotKey(spec.keyCode')],
  'This is the default; change it in Mac settings → Hotkeys.': [
    has('apps/desktop/Sources/TalosDesktopCore/DesktopConfig.swift', 'compose: "ctrl+opt+space"'),
    () => expect(MAC_TAB_TEXT.Hotkeys).toContain('Quick compose hotkey'),
  ],
  'In the box, ⌘↩ sends and Esc closes it.': [
    has('apps/desktop/Sources/TalosDesktop/QuickCompose.swift', 'Send (⌘↩), Esc'),
  ],
  'Shown beside the item in the Talos icon’s menu.': [() => expect(menuBarKeys().length).toBeGreaterThanOrEqual(5)],
  'The item’s name goes on to say what happens to the agent.': [
    has('apps/desktop/Sources/TalosDesktop/App.swift', 'Button("Quit Talos (agent keeps running)")'),
    has('apps/desktop/Sources/TalosDesktop/App.swift', 'Button("Quit Talos (stops the agent)")'),
  ],
  'In the Mac app only, not while typing in a box.': [
    has('apps/web/src/lib/keymap.ts', "scope: 'mac-app'"),
    has('apps/web/src/lib/keymap.ts', 'inField: false'),
    has('apps/web/src/lib/useKeyboard.ts', '!entry.inField && isField(ev.target)'),
  ],
  'In a web browser these two keys stay Back and Forward.': [
    has('apps/web/src/lib/keymap.ts', "scope: 'mac-app'"),
    has('apps/web/src/lib/keymap.ts', 'return entry.scope ==='),
  ],
  'On the app’s main screens, also while you type.': [
    has('apps/web/src/lib/keymap.ts', 'inField: true'),
    has('apps/web/src/lib/useKeyboard.ts', 'const isField'),
  ],
  'It jumps to a thread, searches all messages, opens Schedules, Settings or Memory, starts a new thread, runs a / command and opens the top Needs-you card.':
    [
      has('apps/web/src/features/palette/items.ts', "'searchMessages'"),
      has('apps/web/src/features/palette/items.ts', "type: 'slash'"),
      has('apps/web/src/features/palette/items.ts', "'topCard'"),
      has('apps/web/src/features/palette/Palette.tsx', '<ThreadEditor'),
      has('apps/web/src/lib/keymap.ts', "to: '/schedules'"),
      has('apps/web/src/lib/keymap.ts', "to: '/memory'"),
      has('apps/web/src/lib/keymap.ts', "to: '/settings'"),
    ],
  'It never answers a card.': [
    lacks('apps/web/src/features/palette/Palette.tsx', 'resolveCard'),
    lacks('apps/web/src/features/palette/actions.ts', 'resolveCard'),
    has('apps/web/src/features/palette/Palette.tsx', "if (r.type === 'card') return void nav(`/card/${r.id}`)"),
  ],
  'Arrows move, Enter opens a card.': [
    has('apps/web/src/features/palette/Palette.tsx', "e.key === 'ArrowDown'"),
    has('apps/web/src/features/palette/Palette.tsx', "e.key === 'Enter'"),
  ],
  'The card’s own buttons are the only way to answer it.': [
    lacks('apps/web/src/features/palette/Palette.tsx', 'resolveCard'),
    lacks('apps/web/src/features/palette/items.ts', 'resolveCard'),
  ],
  'In a thread.': [has('apps/web/src/features/palette/actions.ts', 'if (!ctx.currentThreadId) return false')],
  'On other screens the browser keeps the key.': [
    has('apps/web/src/features/palette/actions.ts', 'if (!ctx.currentThreadId) return false'),
    has('apps/web/src/lib/useKeyboard.ts', '!== false'),
  ],
  'In a thread that has a Session panel.': [has('apps/web/src/Shell.tsx', 'if (!hasSession) return false')],
  'The list is also in Settings.': [has('apps/web/src/features/settings/SettingsScreen.tsx', "id: 'shortcuts'")],
  'On the app’s main screens.': [has('apps/web/src/Shell.tsx', 'useGlobalKeys(handlers, { macApp })')],
  'Not on this Help page or the sign-in screen.': [
    () => {
      expect(rd('apps/web/src/features/help/HelpScreen.tsx')).not.toContain('useGlobalKeys')
      expect(rd('apps/web/src/features/auth/LoginPage.tsx')).not.toContain('useGlobalKeys')
    },
  ],
  'On the main screens wide enough to show the sidebar, and not while a sheet is open.': [
    has('apps/web/src/Shell.tsx', "window.matchMedia?.('(min-width: 768px)')"),
    has('apps/web/src/Shell.tsx', '[role="dialog"][data-state="open"]'),
  ],
  // The behaviour is run in composer/enter-key.test.tsx; these only check that those tests still exist under these names.
  'In the message box on a computer.': [has('apps/web/test/composer/enter-key.test.tsx', 'sends on a computer')],
  'Shift+Enter starts a new line.': [has('apps/web/test/composer/enter-key.test.tsx', 'does not send with Shift held')],
  'On a touch screen Enter is always a new line.': [
    has('apps/web/test/composer/enter-key.test.tsx', 'does not send on a touch screen'),
  ],
  // What cannot be done
  'Threads can only be archived, and an archived thread can be restored.': [
    has(THREAD_ED, "Archive only: a thread can't be deleted. Restore it any time."),
    () => expect(rd('packages/protocol/src/http.ts')).not.toMatch(/threadDelete|deleteThread|thread\.delete/i),
  ],
  'The relay address (the server the app talks to) is fixed when the iPhone app is built.': [
    has('docs/ios.md', 'It loads the relay origin fixed at build time'),
  ],
  'The Devices list shows a device’s name and lets you end it.': [
    has('apps/web/src/features/settings/DeviceRow.tsx', '{d.name}'),
    has('apps/web/src/features/settings/DeviceRow.tsx', 'Revoke'),
  ],
  'It has no rename.': [lacks(S, 'Rename device'), () => expect(rd(S)).not.toMatch(/renameDevice/i)],
  'There is no Check for updates button.': [() => expect(ABSENT_LABELS).toContain('Check for updates')],
  'See About below for how to update.': [() => expect(allText()).toContain('Updating.')],
  'They are two voices.': [has(VOICE, 'a different voice from the live-call voice')],
  'The live-call voice is a Settings choice; spoken replies use your Mac’s speech command.': [
    has(VOICE, 'your Mac reads it with its speech command'),
    () => expect(SETTINGS_TEXT.Voice).toContain('Live-call voice'),
  ],
}

/** Every sentence of every note, limit answer and key text. */
function claimSentences(): string[] {
  const texts: string[] = []
  for (const r of whereRows()) if (r.note) texts.push(r.note)
  for (const r of limitRows()) texts.push(r.a)
  for (const g of keyGroups()) for (const r of g.rows) texts.push(r.when)
  return texts.flatMap((t) => stripMarkers(t).split(/(?<=[.!?])\s+/)).filter((s) => s && !NOT_A_CLAIM.has(s))
}

describe('every sentence in a note, a limit or a key text is backed by the code', () => {
  it('each sentence has evidence listed, and no evidence is left for a sentence that is gone', () => {
    const sentences = new Set(claimSentences())
    const unproven = [...sentences].filter((s) => !(s in CLAIMS))
    expect(unproven, 'add evidence for these, or remove them from Help').toEqual([])
    const stale = Object.keys(CLAIMS).filter((k) => !sentences.has(k))
    expect(stale, 'these claims are no longer in Help').toEqual([])
  })

  it('the evidence holds', () => {
    for (const [sentence, proofs] of Object.entries(CLAIMS)) {
      expect(proofs.length, sentence).toBeGreaterThan(0)
      for (const p of proofs) p()
    }
  })
})

describe('Help says only true things about paths, logs, updating and uninstalling', () => {
  it('things Help says are missing really are missing', () => {
    for (const label of ABSENT_LABELS)
      expect(EVERYTHING.includes(norm(label)), `"${label}" now exists; correct Help`).toBe(false)
  })

  it('every home-folder path and script path the text names is real', () => {
    const text = allText()
    const homePaths = [
      ...text.matchAll(/~\/(?:Library\/Application Support\/Talos|[A-Za-z0-9._/-]*[A-Za-z0-9_])/g),
    ].map((m) => m[0])
    expect(homePaths.length).toBeGreaterThanOrEqual(4)
    const places = [
      EVERYTHING,
      read(join(ROOT, 'apps/bridge/src/config.ts')),
      read(join(ROOT, SETUP_GUIDE)),
      read(join(ROOT, 'apps/desktop/scripts/install.sh')),
    ].join('\n')
    for (const p of homePaths) expect(places, p).toContain(p.slice(2))
    const scripts = [...text.matchAll(/apps\/desktop\/scripts\/[a-z-]+\.sh/g)].map((m) => m[0])
    expect(scripts.length).toBeGreaterThanOrEqual(2)
    for (const f of scripts) expect(statSync(join(ROOT, f)).isFile(), f).toBe(true)
    expect(read(join(ROOT, 'apps/desktop/scripts/install.sh'))).toContain('DEST="$HOME/Applications"')
    const setup = read(join(ROOT, SETUP_GUIDE))
    expect(setup).toContain('Uninstalling.')
    expect(setup).toContain('`talos-app update`')
    expect(text).toContain('TALOS_APP_HOME')
    expect(read(join(ROOT, 'apps/bridge/src/config.ts'))).toContain('processEnv.TALOS_APP_HOME')
  })

  it('the log files Help names are the ones the apps write', () => {
    expect(read(join(MAC, 'TalosDesktop/SupervisorController.swift'))).toContain('/Library/Logs/Talos/supervisor.log')
    expect(read(join(ROOT, 'apps/bridge/src/config.ts'))).toContain("join(home, 'bridge.log')")
    expect(read(join(MAC, 'TalosDesktop/SupervisorController.swift'))).toContain('/desktop.json')
  })

  it('the outage lines on the Mac failure screen name a real menu item and real commands', () => {
    const page = read(join(MAC, 'TalosDesktopCore/PageState.swift'))
    const lines = page.slice(page.indexOf('outageHelp'))
    for (const m of lines.matchAll(/talos-app (\w+)/g)) expect(CLI_COMMANDS.has(m[1]), `talos-app ${m[1]}`).toBe(true)
    for (const word of ['Start session', 'status', 'doctor', 'logs']) expect(lines).toContain(word)
    expect(hasLabel(MENU_BAR, 'Start session')).toBe(true)
    // The menu-bar icon is Talos's head: down is the head with a slash, needs you has a dot. Help may not name the old SF Symbols.
    expect(read(join(MAC, 'TalosDesktopCore/MenuBarIcon.swift'))).toContain('case .down: return "talos-down"')
    expect(lines).toContain('a head with a slash through it')
  })

  it('Help describes the menu-bar icon states the way the icon draws them, never as the old flame, bell or triangle', () => {
    const icon = read(join(MAC, 'TalosDesktopCore/MenuBarIcon.swift'))
    expect(icon).toContain('case .needsYou: return "talos-needs-you"')
    const page = read(join(MAC, 'TalosDesktopCore/PageState.swift'))
    const content = read(join(ROOT, 'apps/web/src/features/help/content.ts'))
    for (const [name, text] of [
      ['PageState.swift', page],
      ['content.ts', content],
    ] as const)
      for (const old of ['triangle', 'bell', 'flame', 'question mark'])
        expect(text.toLowerCase().includes(old), `${name} still says "${old}"`).toBe(false)
    expect(content).toContain('A head with a slash through it')
    expect(content).toContain('A dot on the Talos icon in the Mac menu bar')
  })
})

describe('Help says how Settings behaves with the Mac offline', () => {
  it('the sections that save through the Mac really go read-only, and Account and Appearance do not', () => {
    for (const id of ['agent', 'notifications', 'voice', 'session']) expect(WRITES_SYNCED_CONFIG).toContain(id)
    for (const id of ['account', 'appearance', 'health']) expect(WRITES_SYNCED_CONFIG).not.toContain(id)
    // the sentence that says it is in the text, and is about exactly these sections
    expect(allText()).toContain('read-only while your Mac is offline')
  })
})

describe('Help text hygiene', () => {
  it('has unique sections, every section has text, and no marker is left open', () => {
    const ids = HELP_SECTIONS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of HELP_SECTIONS) expect(s.blocks.map(blockText).join('').length, s.id).toBeGreaterThan(40)
    const t = allStrings().join('\n')
    expect(t.match(/\[\[/g)?.length).toBe(t.match(/\]\]/g)?.length)
    expect(t.match(/\{\{/g)?.length).toBe(t.match(/\}\}/g)?.length)
    expect(t.match(/\(\(/g)?.length).toBe(t.match(/\)\)/g)?.length)
  })

  it('covers every part the plan lists, with the fixes it names', () => {
    expect(HELP_SECTIONS.map((s) => s.id)).toEqual(['which', 'where', 'setup', 'fix', 'keys', 'limits', 'about'])
    const fix = blocks().find((b) => b.kind === 'fix')
    expect(fix && fix.kind === 'fix' ? fix.rows.map((r) => r.id) : []).toEqual([
      'no-notifications',
      'mac-offline',
      'locked-out',
      'dialog',
      'no-replies',
    ])
  })

  it('the step that creates the setup is the Agent folder row with Create, Adopt and Choose, as the Mac app itself says', () => {
    const setup = HELP_SECTIONS.find((s) => s.id === 'setup')
    const first = setup?.blocks.find((b) => b.kind === 'steps')
    const step = first && first.kind === 'steps' ? first.items[0] : ''
    expect(step).toMatch(/Agent folder[\s\S]*Create[\s\S]*Adopt[\s\S]*Choose[\s\S]*no setup file exists/)
    expect(step).toMatch(/Import[\s\S]*starts/)
    expect(read(join(MAC, 'TalosDesktopCore/FirstRun.swift'))).toContain('"Agent folder"')
    const panel = read(join(MAC, 'TalosDesktop/AgentFolderPanel.swift'))
    for (const b of ['Create', 'Adopt', 'Choose']) expect(hasLabel(panel, b), b).toBe(true)
    expect(hasLabel(MAC_TAB_TEXT.Session ?? '', 'Import')).toBe(true)
  })

  it('holds no personal path, address or id', () => {
    const t = allText()
    expect(t).not.toMatch(/\/Users\/|\/home\/[a-z]|@[a-z0-9-]+\.[a-z]{2,}|\b\d{9,}\b/i)
  })

  it('is one source: the Mac app has no second copy of the text', () => {
    expect(() => statSync(join(MAC, 'TalosDesktopCore/HelpContent.swift'))).toThrow()
    expect(() => statSync(join(MAC, 'TalosDesktop/HelpView.swift'))).toThrow()
  })

  it('the screens that link to Help do not pull its text into the main bundle', () => {
    for (const f of ['App.tsx', 'features/auth/LoginPage.tsx', 'features/settings/SettingsScreen.tsx']) {
      const t = read(join(WEB, f))
      expect(t, f).not.toMatch(/from '[^']*help\/content\.ts'/)
      expect(t, f).toContain("help/path.ts'")
    }
    const outside = WEB_ALL.filter((f) => /help\/(content|HelpBlocks|HelpScreen)\.tsx?'/.test(readFileSync(f, 'utf8')))
    // the only door into the text from the main bundle is the lazy import in App.tsx
    expect(outside.map((f) => f.replace(`${WEB}/`, ''))).toEqual(['App.tsx'])
    expect(read(join(WEB, 'App.tsx'))).toMatch(/lazy\(\(\) => import\('\.\/features\/help\/HelpScreen\.tsx'\)/)
  })
})
