// Pure parts of thread management (docs/THREADS.md): palette contrast, icon resolution, reorder maths.
import type { ThreadT } from '@talos-app/protocol'
import { THREAD_COLORS } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { moveItem, slotShift, targetIndex } from '../../src/features/threads/manage/reorder.ts'
import { reorderThreads, wireThreads } from '../../src/features/threads/manage/useThreadPatch.ts'
import {
  INK,
  resolveThreadIcon,
  searchIcons,
  THREAD_COLOR,
  THREAD_ICONS,
  threadColorHex,
} from '../../src/ui/threadIcons.ts'

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

describe('thread palette', () => {
  it('covers every protocol colour key', () => {
    expect(Object.keys(THREAD_COLOR).sort()).toEqual([...THREAD_COLORS].sort())
  })
  it('black ink reads on every fill at 6:1 or better (icons need 3:1), and each fill stands off the dark ground', () => {
    for (const [k, { hex }] of Object.entries(THREAD_COLOR)) {
      expect(contrast(hex, INK), k).toBeGreaterThanOrEqual(6)
      expect(contrast(hex, '#1c1815'), `${k} on dark surface`).toBeGreaterThanOrEqual(3) // non-text contrast
    }
  })
  it('unknown keys render default', () => {
    expect(threadColorHex('teal')).toBeUndefined()
    expect(threadColorHex(undefined)).toBeUndefined()
    expect(threadColorHex('orange')).toBe(THREAD_COLOR.orange.hex)
  })
})

describe('thread icons', () => {
  it('keys are unique, short enough for Thread.icon (16) and not colliding with art keys', () => {
    const keys = THREAD_ICONS.map((i) => i.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((k) => k.length <= 16 && !k.startsWith('art-'))).toBe(true)
    expect(keys.length).toBeGreaterThanOrEqual(40)
  })
  it('resolves a glyph, chosen art, and falls back to art by id for emoji or nothing', () => {
    expect(resolveThreadIcon('x', 'rocket')).toMatchObject({ kind: 'glyph', icon: { key: 'rocket' } })
    expect(resolveThreadIcon('x', 'art-reading')).toEqual({ kind: 'art', name: 'reading' })
    expect(resolveThreadIcon('work', '💼')).toEqual({ kind: 'art', name: 'work' })
    expect(resolveThreadIcon('trip')).toEqual({ kind: 'art', name: 'general' })
    expect(resolveThreadIcon('x', 'art-nope')).toEqual({ kind: 'art', name: 'general' })
  })
  it('search matches labels and keywords', () => {
    expect(searchIcons('travel').map((i) => i.key)).toEqual(expect.arrayContaining(['plane', 'map-pin', 'globe']))
    expect(searchIcons('zzzz')).toEqual([])
    expect(searchIcons('').length).toBe(THREAD_ICONS.length)
  })
})

describe('reorder', () => {
  it('moveItem moves without mutating', () => {
    const a = ['a', 'b', 'c', 'd']
    expect(moveItem(a, 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(a, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(a).toEqual(['a', 'b', 'c', 'd'])
  })
  it('targetIndex follows the dragged row centre past neighbours', () => {
    const rects = [0, 50, 100, 150].map((top) => ({ top, height: 48 }))
    expect(targetIndex(rects, 0, 0)).toBe(0)
    expect(targetIndex(rects, 0, 30)).toBe(0)
    expect(targetIndex(rects, 0, 55)).toBe(1)
    expect(targetIndex(rects, 0, 110)).toBe(2)
    expect(targetIndex(rects, 0, 999)).toBe(3)
    expect(targetIndex(rects, 3, -120)).toBe(1)
  })
  it('slotShift opens the gap', () => {
    expect(slotShift(0, 2, 1, 50)).toBe(-50)
    expect(slotShift(0, 2, 3, 50)).toBe(0)
    expect(slotShift(3, 1, 1, 50)).toBe(50)
    expect(slotShift(3, 1, 0, 50)).toBe(0)
  })
  it('reorderThreads fills the moved threads into their own slots; the inbox and archived threads stay put', () => {
    const t = (id: string, order: number, archived = false) => ({ id, name: id, order, archived }) as ThreadT
    const out = reorderThreads([t('inbox', 1), t('a', 0), t('b', 2), t('old', 3, true), t('c', 4)], ['c', 'a', 'b'])
    expect(out.map((x) => [x.id, x.order])).toEqual([
      ['c', 0],
      ['inbox', 1],
      ['a', 2],
      ['old', 3],
      ['b', 4],
    ])
  })
  it('wireThreads sends null for cleared icon/color/topic only to a threads/2 Mac', () => {
    const t = { id: 'a', name: 'A', order: 0, archived: false, color: 'red' } as ThreadT
    expect(wireThreads([t], true)[0]).toMatchObject({ color: 'red', icon: null, topic: null })
    expect(wireThreads([t], false)[0]).not.toHaveProperty('icon')
  })
})
