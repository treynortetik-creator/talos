// The Mac's keyframe drawn by a real xterm (its core, without a screen): a pane with a scroll region set must come out with its
// bottom row drawn. Set before the rows, the region squeezes every row through it and leaves the rows outside it blank.
import { Terminal } from '@xterm/xterm'
import { expect, it } from 'vitest'
import { keyframeBytes } from '../../../bridge/src/term/control.ts'

const enc = new TextEncoder()
const draw = async (bytes: Uint8Array, cols: number, rows: number) => {
  const t = new Terminal({ cols, rows, allowProposedApi: true })
  await new Promise<void>((r) => t.write(bytes, r))
  const lines = Array.from({ length: rows }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true) ?? '')
  t.dispose()
  return lines
}

it('a pane with a scroll region: every row is drawn, the bottom one included, and the cursor is where the pane had it', async () => {
  // a 6-row pane whose app set rows 2..5 as the scrolling region (a status line above, an input box below)
  const screen = ['status line', 'body one', 'body two', 'body three', 'body four', '> input box']
  const bytes = keyframeBytes(
    screen.map((l) => enc.encode(l)),
    2,
    5,
    { alt: false, cursorHidden: false, region: [1, 4] },
  )
  expect(await draw(bytes, 20, 6)).toEqual(screen)
})

it('without a region the same rows draw the same way (control)', async () => {
  const screen = ['one', 'two', 'three']
  const bytes = keyframeBytes(
    screen.map((l) => enc.encode(l)),
    0,
    2,
    { alt: false, cursorHidden: false, region: null },
  )
  expect(await draw(bytes, 10, 3)).toEqual(screen)
})
