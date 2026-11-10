// Settings > Keyboard shortcuts: the keymap table, listed. Rebinding is a later package (see lib/keymap.ts).
import { chordLabel, DEFAULT_KEYMAP, isMacPlatform, type KeyEntry } from '../../lib/keymap.ts'
import type { SectionProps } from './sections.tsx'

const chordOf = (id: string) => DEFAULT_KEYMAP.find((e) => e.id === id)?.chord ?? null
const GROUPS: KeyEntry['group'][] = ['Go to', 'Threads', 'Panels', 'App']

export function ShortcutsSection({ mac = isMacPlatform() }: SectionProps & { mac?: boolean }) {
  const listed = DEFAULT_KEYMAP.filter((e) => e.chord && e.id !== 'call' && !/^thread[2-9]$/.test(e.id))
  return (
    <section aria-labelledby="shortcuts-h" data-testid="shortcuts-section">
      <h2 id="shortcuts-h" className="m-0 mb-3 font-display text-xl font-semibold">
        Keyboard shortcuts
      </h2>
      <p className="mt-0 text-sm text-text-2">
        Cmd (or Ctrl) chords work while you type. Plain keys never do. Everything here is also in the palette (
        {chordLabel(chordOf('palette'), mac)}).
      </p>
      {GROUPS.map((g) => {
        const rows = listed.filter((e) => e.group === g)
        if (rows.length === 0) return null
        return (
          <div key={g} className="mb-4">
            <h3 className="m-0 mb-1 text-sm font-semibold text-text-2">{g}</h3>
            <ul className="m-0 list-none divide-y divide-line p-0">
              {rows.map((e) => (
                <li key={e.id} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    {e.label}
                    {e.id === 'thread1' && (
                      <span className="block text-xs text-text-2">
                        {chordLabel(chordOf('thread2'), mac)} to {chordLabel(chordOf('thread9'), mac)} open threads 2 to
                        9.
                      </span>
                    )}
                    {e.scope === 'mac-app' && (
                      <span className="block text-xs text-text-2">
                        Mac app only. In a browser this key stays Back or Forward.
                      </span>
                    )}
                  </span>
                  <kbd className="shrink-0 rounded-button border border-line px-1.5 font-mono text-xs">
                    {chordLabel(e.chord, mac)}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </section>
  )
}
