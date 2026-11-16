// The hostile nightly's clock shift (docs/CI-MACHINES.md, "The hostile nightly"): preloaded into every Node process
// (NODE_OPTIONS=--require) and every bun process (BUN_OPTIONS=--preload) of a hostile run, it moves the wall clock that
// JavaScript reads, Date.now() and `new Date()`, by TALOS_HOSTILE_CLOCK_MS milliseconds. Only that: timers, performance.now()
// and process.hrtime are untouched, so timeouts and measured durations behave as before. Swift, the shell's `date` and
// file times are not shifted. Without the variable (or with 0, or a value that is not a whole number) it does nothing.
'use strict'

const raw = process.env.TALOS_HOSTILE_CLOCK_MS
const off = /^-?\d{1,15}$/.test(raw ?? '') ? Number(raw) : 0
if (off !== 0 && !globalThis.__talosHostileClockMs) {
  const RealDate = Date
  const now = () => RealDate.now() + off
  // Called as a function, Date() gives the time as a string; with `new` and no argument, a Date of now. Anything else (a
  // given time, or a subclass's super()) is the real Date's own.
  const ShiftedDate = function (...args) {
    if (!new.target) return new RealDate(now()).toString()
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target)
  }
  ShiftedDate.prototype = RealDate.prototype // instanceof Date and every method stay the real ones
  RealDate.prototype.constructor = ShiftedDate // so new Date().constructor === Date, as before
  Object.setPrototypeOf(ShiftedDate, RealDate) // Date.UTC and Date.parse
  Object.defineProperty(ShiftedDate, 'name', { value: 'Date' })
  Object.defineProperty(ShiftedDate, 'length', { value: 7 })
  ShiftedDate.now = now
  globalThis.Date = ShiftedDate
  globalThis.__talosHostileClockMs = off
}
