// tmux control mode, read as BYTES (src/term/control.ts): the escapes, a chunk that ends anywhere, the replies to our own commands
// and not to the attach, and the keyframe that redraws a pane. The `%output` lines below are byte copies of what tmux 3.8 printed
// for the commands noted beside them (a real run, see tmux-real.test.ts for the live one).
import { describe, expect, test } from 'bun:test'
import { TERM_KEY_MAX_BYTES } from '@talos-app/protocol'
import {
  askOn,
  attachArgs,
  ControlParser,
  controlCommands,
  cutRow,
  isAllowedControlCommand,
  keyframeBytes,
  unescapeOutput,
  writeControl,
} from '../../src/term/control.ts'
import { Ring } from '../../src/term/ring.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...enc.encode(p)] : p)))

describe('unescapeOutput', () => {
  test('octal escapes become the byte, a backslash is \\134, and bytes above 0x7f pass through raw', () => {
    // printf '\033[31mred\033[0m caf\303\251 back\\slash \342\202\254\r\n' in a pane, as tmux 3.8 sent it (the line after "%output %0 ")
    const wire = bytes(
      '\\033[31mred\\033[0m caf',
      [0xc3, 0xa9],
      ' back\\134slash ',
      [0xe2, 0x82, 0xac],
      '\\015\\015\\012',
    )
    const raw = unescapeOutput(wire)
    expect(dec.decode(raw)).toBe('\x1b[31mred\x1b[0m café back\\slash €\r\r\n')
  })
  test('a lone backslash or a short or non-octal escape is left as it is, never swallowed', () => {
    expect(dec.decode(unescapeOutput(bytes('a\\')))).toBe('a\\')
    expect(dec.decode(unescapeOutput(bytes('a\\0')))).toBe('a\\0')
    expect(dec.decode(unescapeOutput(bytes('\\089')))).toBe('\\089')
    expect(dec.decode(unescapeOutput(bytes('\\777')))).toBe('\\777') // first digit above 3 is not a byte
  })
  test('every byte value survives a round trip through the escape', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    const wire = bytes(...[...all].map((b) => (b < 0x20 || b === 0x5c ? `\\${b.toString(8).padStart(3, '0')}` : [b])))
    expect([...unescapeOutput(wire)]).toEqual([...all])
  })
})

describe('ControlParser', () => {
  const run = (chunks: Uint8Array[]) => {
    const p = new ControlParser()
    return chunks.flatMap((c) => p.push(c))
  }

  test('output lines for a pane, whatever the chunk boundaries (inside a line, an escape and a UTF-8 code point)', () => {
    const text = bytes('%output %3 hi \\033[1mcaf', [0xc3, 0xa9], '\\012\n%output %3 second\n')
    for (let cut = 1; cut < text.length; cut++) {
      const ev = run([text.slice(0, cut), text.slice(cut)])
      const out = ev.filter((e) => e.kind === 'output')
      expect(out.length).toBe(2)
      expect(dec.decode((out[0] as { data: Uint8Array }).data), `cut ${cut}`).toBe('hi \x1b[1mcafé\n')
      expect(dec.decode((out[1] as { data: Uint8Array }).data)).toBe('second')
    }
  })

  test('the reply to the attach itself (flags 0) is not an answer; the reply to our command (flags 1) is, with its lines', () => {
    const text = bytes(
      '%begin 1795785024 336 0\n%end 1795785024 336 0\n%session-changed $0 agent\n',
      '%begin 1795785024 338 1\n%0 100 30\n%end 1795785024 338 1\n',
    )
    const ev = run([text])
    const replies = ev.filter((e) => e.kind === 'reply') as Array<{ ok: boolean; lines: Uint8Array[] }>
    expect(replies.length).toBe(1)
    expect(replies[0]?.ok).toBe(true)
    expect(replies[0]?.lines.map((l) => dec.decode(l))).toEqual(['%0 100 30'])
  })

  test('a very long line in many small chunks is read once, not re-copied per chunk', () => {
    // 1.5 MB in 100-byte chunks: re-copying the buffer on every chunk would be 15,000 copies of up to 1.5 MB (hung, not slow)
    const p = new ControlParser()
    const body = `%output %0 ${'a'.repeat(1_500_000)}\n`
    const all = enc.encode(body)
    const out: ReturnType<ControlParser['push']> = []
    for (let i = 0; i < all.length; i += 100) out.push(...p.push(all.subarray(i, i + 100)))
    expect(out.length).toBe(1)
    expect((out[0] as { data: Uint8Array }).data.length).toBe(1_500_000)
  })

  test('a refused command is a reply with ok false', () => {
    const ev = run([bytes('%begin 1 340 1\nclient is read-only\n%error 1 340 1\n')])
    expect(ev).toEqual([{ kind: 'reply', ok: false, lines: [enc.encode('client is read-only')] }])
  })

  test('a captured line that looks like a notification or an end is payload, until the end that matches the begin', () => {
    const ev = run([
      bytes(
        '%begin 5 9 1\n%output %0 not output\n%end 5 8 1\n%exit\n%layout-change nope\nreal\n%end 5 9 1\n%output %0 live\n',
      ),
    ])
    expect(ev.map((e) => e.kind)).toEqual(['reply', 'output'])
    const r = ev[0] as { lines: Uint8Array[] }
    expect(r.lines.map((l) => dec.decode(l))).toEqual([
      '%output %0 not output',
      '%end 5 8 1',
      '%exit',
      '%layout-change nope',
      'real',
    ])
  })

  test('layout changes and the exit are events; other notifications are ignored; a bad pane id is dropped', () => {
    const ev = run([
      bytes(
        '%layout-change @0 9f1d,30x10,0,0,0 9f1d,30x10,0,0,0 *\n%window-renamed @0 bash\n%output nonsense x\n%exit\n',
      ),
    ])
    expect(ev.map((e) => e.kind)).toEqual(['layout', 'exit'])
  })
})

describe('keyframeBytes', () => {
  const rows = (...l: string[]) => l.map((x) => enc.encode(x))
  const flags = { alt: false, cursorHidden: false, region: null as [number, number] | null }

  test('resets the terminal, clears the screen and the scrollback, joins the rows by plain CR LF, and puts the cursor back', () => {
    const k = dec.decode(keyframeBytes(rows('one', 'two', ''), 4, 1, flags))
    expect(k).toBe('\x1bc\x1b[H\x1b[2J\x1b[3Jone\r\ntwo\r\n\x1b[0m\x1b[2;5H')
  })

  test('a colour carries across a line break: nothing resets it between rows (capture-pane -e relies on that)', () => {
    // two rows of one red run, as capture-pane -e prints them: the red starts on the first row and is still on in the second
    const k = dec.decode(keyframeBytes(rows('\x1b[31mred one', 'red two\x1b[39m'), 0, 0, flags))
    expect(k).toContain('\x1b[31mred one\r\nred two\x1b[39m')
    expect(k).not.toContain('\x1b[0m\r\n')
  })

  test("the pane's own modes come back: alternate screen, a hidden cursor, a scroll region", () => {
    const k = dec.decode(keyframeBytes(rows('x'), 2, 3, { alt: true, cursorHidden: true, region: [2, 19] }))
    expect(k.startsWith('\x1bc\x1b[?1049h')).toBe(true)
    expect(k).toContain('\x1b[?25l')
    // 1-based, AFTER the rows (set first, every row would be squeezed through it and the rows outside it left blank) and before the
    // cursor is placed (setting a region homes the cursor)
    const withRows = dec.decode(
      keyframeBytes(rows('first', 'last'), 2, 3, { alt: false, cursorHidden: false, region: [2, 19] }),
    )
    expect(withRows.indexOf('\x1b[3;20r')).toBeGreaterThan(withRows.indexOf('last'))
    expect(withRows.indexOf('\x1b[3;20r')).toBeLessThan(withRows.indexOf('\x1b[4;3H'))
    expect(k).toContain('\x1b[3;20r')
    expect(k.endsWith('\x1b[4;3H')).toBe(true)
    // and a plain pane has none of those
    const plain = dec.decode(keyframeBytes(rows('x'), 0, 0, flags))
    expect(plain).not.toMatch(/\?1049h|\?25l|\d;\d+r/)
  })

  test('too much history for one frame: the oldest lines go, the last rows (the screen) stay', () => {
    const many = rows(...Array.from({ length: 50 }, (_, i) => `line ${String(i).padStart(2, '0')} ${'x'.repeat(20)}`))
    const k = keyframeBytes(many, 0, 0, flags, 600)
    expect(k.length).toBeLessThanOrEqual(600)
    const t = dec.decode(k)
    expect(t).toContain('line 49')
    expect(t).not.toContain('line 00')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the point
    expect(t).toMatch(/\x1b\[3J(line \d\d x{20})/)
  })

  test('a frame far over 128 KiB is cut to it by default', () => {
    const big = rows(...Array.from({ length: 5000 }, () => 'y'.repeat(100)))
    expect(keyframeBytes(big, 0, 0, flags).length).toBeLessThanOrEqual(128 * 1024)
  })

  test('one 300 KB line (a long -J row) is cut to fit, at a character boundary and outside an escape sequence', () => {
    // coloured runs and multi-byte characters all along it
    const unit = '\x1b[38;5;208mcafé €\x1b[0m '
    const line = unit.repeat(Math.ceil(300_000 / unit.length))
    const screen = [line, ...Array.from({ length: 28 }, (_, i) => `row ${i}`)]
    const k = keyframeBytes(rows(...screen), 0, 28, flags)
    expect(k.length).toBeLessThanOrEqual(TERM_KEY_MAX_BYTES)
    // valid UTF-8 throughout (a cut inside a character would throw)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(k)
    // the long row ends whole: its last piece is not the start of an escape sequence
    const firstRow = text.split('\r\n')[0] as string
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the point
    expect(firstRow).not.toMatch(/\x1b(\[[0-9;]*)?$/)
    // the short rows after it are all there
    expect(text).toContain('row 27')
  })

  test('cutRow never ends inside an escape sequence or a character', () => {
    const row = enc.encode('ab\x1b[38;5;208mcd€ef\x1b]0;title\x07gh')
    for (let max = 0; max <= row.length; max++) {
      const cut = cutRow(row, max)
      expect(cut.length).toBeLessThanOrEqual(max)
      new TextDecoder('utf-8', { fatal: true }).decode(cut)
      const t = dec.decode(cut)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is the point
      expect(t).not.toMatch(/\x1b(\[[0-9;]*|\][^\x07]*)?$/)
    }
  })
})

describe('Ring', () => {
  test('absolute offsets: head counts every byte, start moves once the ring is full, and a slice wraps', () => {
    const r = new Ring(8)
    r.push(Uint8Array.of(1, 2, 3, 4, 5))
    expect([r.start, r.head]).toEqual([0, 5])
    r.push(Uint8Array.of(6, 7, 8, 9, 10))
    expect([r.start, r.head]).toEqual([2, 10])
    expect([...r.slice(2, 100)]).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    expect([...r.slice(7, 2)]).toEqual([8, 9])
    expect([...r.slice(10, 5)]).toEqual([])
  })
  test('a push bigger than the ring keeps its last bytes, at the right offsets', () => {
    const r = new Ring(4)
    r.push(Uint8Array.of(0, 0))
    r.push(Uint8Array.from({ length: 10 }, (_, i) => i + 10))
    expect([r.start, r.head]).toEqual([8, 12])
    expect([...r.slice(8, 10)]).toEqual([16, 17, 18, 19])
  })
  test('an offset that fell out, or is ahead of the stream, is refused', () => {
    const r = new Ring(4)
    r.push(Uint8Array.of(1, 2, 3, 4, 5, 6))
    expect(() => r.slice(1, 1)).toThrow(RangeError)
    expect(() => r.slice(7, 1)).toThrow(RangeError)
  })
  test('property: any pushes read back as the last `capacity` bytes of everything pushed', () => {
    const r = new Ring(16)
    const all: number[] = []
    let seed = 7
    for (let i = 0; i < 200; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const n = seed % 23
      const chunk = Uint8Array.from({ length: n }, (_, j) => (seed + j) & 255)
      r.push(chunk)
      all.push(...chunk)
      expect([...r.slice(r.start, 1000)]).toEqual(all.slice(Math.max(0, all.length - 16)))
      expect(r.head).toBe(all.length)
    }
  })
})

describe("the control client's stdin: one writer, an allowlist", () => {
  const allowed = [
    controlCommands.first('agent'),
    controlCommands.first('t-release_notes'),
    controlCommands.size('%0'),
    controlCommands.size('%12'),
    controlCommands.capture('%3', 1000),
    controlCommands.capture('%3', 50),
    controlCommands.cursor('%3'),
  ]

  test('every command the view needs passes', () => {
    for (const c of allowed) expect(isAllowedControlCommand(c), c).toBe(true)
  })

  test('anything else is refused: keys, pasting, buffers, resizing, a chain, an injected newline, other formats', () => {
    const refused = [
      'send-keys -t %0 -l rm',
      'send-keys -t %0 Enter',
      'send-keys -H -t %0 41',
      'paste-buffer -t %0',
      'set-buffer hello',
      'refresh-client -C 10x10',
      'resize-pane -t %0 -x 10',
      'resize-window -t %0 -x 10',
      'run-shell id',
      'kill-session -t =agent',
      'respawn-pane -k -t %0',
      'attach-session -t =agent',
      `${controlCommands.size('%0')}; send-keys -t %0 x`,
      `${controlCommands.size('%0')} ; send-keys -t %0 x`,
      `${controlCommands.size('%0')}\nsend-keys -t %0 x`,
      `${controlCommands.size('%0')}\r`,
      `\n${controlCommands.size('%0')}`,
      "display-message -p -t %0 '#{pane_width}' ; kill-server",
      "display-message -p -t %0 '#(id)'", // a shell command inside a format
      "display-message -p -t %0 '#{pane_current_command}'", // a format the view does not use
      "display-message -p -t %0:1 '#{pane_width} #{pane_height}'",
      "display-message -p -t %x '#{pane_width} #{pane_height}'",
      controlCommands.capture('%3', 1000).replace('-p', '-pb x'),
      'capture-pane -p -e -J -S -1000 -t %3 -b buf', // capture into a buffer (a write) is not the view's read
      "display-message -t %0 -p '#{pane_width} #{pane_height}'",
      '',
      "display-message -p -t =a;b: '#{pane_id} #{pane_width} #{pane_height}'",
    ]
    for (const c of refused) expect(isAllowedControlCommand(c), JSON.stringify(c)).toBe(false)
  })

  test('the single writer throws BEFORE writing a refused command, and writes an allowed one as one line', () => {
    const wrote: string[] = []
    const stdin = { write: (d: string) => void wrote.push(d) }
    for (const c of ['send-keys -t %0 x', `${controlCommands.size('%0')}\nsend-keys x`]) {
      expect(() => writeControl(stdin, c)).toThrow()
    }
    expect(wrote).toEqual([])
    writeControl(stdin, controlCommands.size('%0'))
    expect(wrote).toEqual([`${controlCommands.size('%0')}\n`])
  })

  test("the client is a control-mode client that ignores size, and is not attached read-only (a read-only client breaks the agent's own keys)", () => {
    const a = attachArgs({ configPath: '/c.conf', socket: 's' }, 'agent')
    expect(a).toEqual(['-L', 's', '-f', '/c.conf', '-C', 'attach', '-f', 'ignore-size', '-t', '=agent'])
    expect(attachArgs({ configPath: '/c.conf', socket: 's', extraArgs: ['-Z'] }, 'agent')).toContain('-Z') // a test seam: a flag tmux refuses
    expect(a).not.toContain('-r')
  })
})
