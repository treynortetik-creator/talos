// Pure reorder maths for ReorderList (unit-tested in test/threads/manage.test.ts).

/** `list` with the item at `from` moved to `to`. Never mutates. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = list.slice()
  if (from < 0 || from >= next.length) return next
  const [x] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, x as T)
  return next
}

/** Where a row dragged `dy` px from slot `from` would land, from the rows' rects captured at drag start. */
export function targetIndex(rects: ReadonlyArray<{ top: number; height: number }>, from: number, dy: number): number {
  const r = rects[from]
  if (!r) return from
  const center = r.top + r.height / 2 + dy
  let to = from
  for (let j = 0; j < rects.length; j++) {
    if (j === from) continue
    const c = (rects[j] as { top: number; height: number }).top + (rects[j] as { height: number }).height / 2
    if (j < from && center < c) to = Math.min(to, j)
    if (j > from && center > c) to = Math.max(to, j)
  }
  return to
}

/** How far a non-dragged row at slot `j` slides to open the gap while a row moves from `from` to `to`. */
export function slotShift(from: number, to: number, j: number, h: number): number {
  if (from < to && j > from && j <= to) return -h
  if (to < from && j >= to && j < from) return h
  return 0
}
