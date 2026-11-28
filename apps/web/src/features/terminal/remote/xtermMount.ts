// xterm.js in the page, read-only (@xterm/xterm 5.5.0 and @xterm/addon-fit 0.10.0, pinned exactly), loaded by dynamic import only
// when the screen opens. It runs under the relay's real CSP with NO change to it (`style-src 'self'`, never 'unsafe-inline'): the
// DOM renderer makes two <style> elements, which that policy blocks, so `open()` runs through the adopted-sheets shim below (option
// (c) of the xterm CSP spike: the two elements become constructed stylesheets, which style-src does not govern). xterm.css is a real
// file Vite emits. A test (test/terminal/remote-terminal.spec.ts) fails on any CSP violation, so a new <style> after an upgrade
// shows up there and not as silently missing colours.
//
// Read-only: `disableStdin`, no `onData` listener (so nothing xterm would emit, a key or an answer to a query, goes anywhere),
// and the helper textarea can neither take focus nor show a keyboard.
import type { TermSink } from './session.ts'

/**
 * Runs `open` (xterm's `term.open(host)`) with `document.createElement('style')` returning a comment node whose `textContent`
 * setter hands the CSS to a constructed stylesheet in `document.adoptedStyleSheets`, and whose `remove()` drops it again. Only
 * while `open` runs; nothing else on the page sees the swap.
 */
export function openWithAdoptedStyles(doc: Document, open: () => void): void {
  const real = doc.createElement
  doc.createElement = function (this: Document, tag: string, opts?: ElementCreationOptions) {
    if (tag.toLowerCase() !== 'style') return real.call(this, tag, opts)
    const sheet = new CSSStyleSheet()
    doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
    const node = doc.createComment('xterm-style')
    Object.defineProperty(node, 'textContent', {
      configurable: true,
      get: () => '',
      set: (css: string) => sheet.replaceSync(css),
    })
    const removeNode = node.remove.bind(node)
    node.remove = () => {
      doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet)
      removeNode()
    }
    return node as unknown as HTMLElement
  } as typeof doc.createElement
  try {
    open()
  } finally {
    delete (doc as { createElement?: unknown }).createElement
  }
}

export interface MountedTerminal {
  sink: TermSink
  /** Makes the pane's columns fit `width` px by choosing the font size (9 to 14 px); narrower still, the box scrolls sideways. */
  fitTo(width: number): void
  dispose(): void
}

// The terminal is dark in both app themes, like the mock: its own palette, with every colour held to 4.5:1 against the background.
const THEME = {
  background: '#0a0e10',
  foreground: '#cfe0e6',
  cursor: '#cfe0e6',
  cursorAccent: '#0a0e10',
  selectionBackground: '#2f5368',
  black: '#2b3a44',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#e3b341',
  blue: '#79b8ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  white: '#cfe0e6',
  brightBlack: '#8b9aa5',
  brightRed: '#ffa198',
  brightGreen: '#9be9a8',
  brightYellow: '#f2cc60',
  brightBlue: '#a5d6ff',
  brightMagenta: '#e2c5ff',
  brightCyan: '#76e4f7',
  brightWhite: '#f0f6fc',
}

export const FONT_MIN = 9
export const FONT_MAX = 14

export async function mountTerminal(host: HTMLElement, size: { cols: number; rows: number }): Promise<MountedTerminal> {
  // one dynamic import each, and the stylesheet as a real file (same-origin, so style-src 'self' allows it)
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css'),
  ])
  const term = new Terminal({
    cols: size.cols,
    rows: size.rows,
    disableStdin: true,
    cursorBlink: false,
    scrollback: 1000,
    fontFamily: "'JetBrains Mono Variable', 'JetBrains Mono', Menlo, ui-monospace, monospace",
    fontSize: FONT_MAX,
    lineHeight: 1.2,
    minimumContrastRatio: 4.5,
    theme: THEME,
    allowProposedApi: false,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  openWithAdoptedStyles(document, () => term.open(host))
  // xterm paints faint text (SGR 2) as the foreground at half alpha, which is under 4.5:1 on this background whatever the palette:
  // a solid grey instead (still dimmer than the rest, about 8:1). Another constructed stylesheet, so no CSP change either.
  const faint = new CSSStyleSheet()
  faint.replaceSync('.xterm .xterm-rows .xterm-dim { color: #9fb3bd !important; }')
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, faint]
  // never a keyboard on a phone, and never a way for the page's focus to land where a key could be taken
  const area = host.querySelector('textarea')
  if (area) {
    area.setAttribute('readonly', '')
    area.setAttribute('inputmode', 'none')
    area.setAttribute('aria-hidden', 'true')
    area.tabIndex = -1
    area.addEventListener('focus', () => area.blur())
  }
  let pane = { ...size }
  return {
    sink: {
      write: (bytes, done) => term.write(bytes, done),
      reset: () => term.reset(),
      resize: (cols, rows) => {
        pane = { cols, rows }
        term.resize(cols, rows)
      },
    },
    fitTo(width) {
      host.style.width = `${Math.max(0, Math.floor(width))}px`
      let fs = FONT_MAX
      for (; fs > FONT_MIN; fs--) {
        term.options.fontSize = fs
        const dims = fit.proposeDimensions()
        if (dims && dims.cols >= pane.cols) break
      }
      term.options.fontSize = fs
      // the page never scrolls sideways: whatever still does not fit scrolls inside the terminal box
      host.style.width = ''
    },
    dispose: () => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== faint)
      term.dispose()
    },
  }
}
