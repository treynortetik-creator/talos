// After a key ran something in the palette, the same Enter must not go on to the page: a held key repeats, and the next focus owner
// (the message box, a card's Allow) would take the repeat as its own. Until Enter comes up, Enter key-downs stop in the capture phase.
let active = false

export function swallowEnterUntilKeyUp(): void {
  if (active || typeof window === 'undefined') return
  active = true
  const down = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return
    if (!e.repeat) return done() // a fresh press: the old key-up was missed (focus left the window), so this is not the held one
    e.preventDefault()
    e.stopPropagation()
  }
  const done = () => {
    active = false
    window.removeEventListener('keydown', down, true)
    window.removeEventListener('keyup', up, true)
    window.removeEventListener('blur', done)
  }
  const up = (e: KeyboardEvent) => {
    if (e.key === 'Enter') done()
  }
  window.addEventListener('keydown', down, true)
  window.addEventListener('keyup', up, true)
  window.addEventListener('blur', done)
}
