// Settings > Appearance > Colour theme: the three stock themes, each with a swatch, and a Default theme button. The pick
// is saved to the owner's config (so every device follows) and applied at once. A real refusal puts the old theme back;
// "Mac offline" does not, because the relay keeps the patch and the Mac applies it when it is back.
// Default theme is an ordinary pick of talos: the same code path and the same patch as tapping Talos.
import { STOCK_THEME_IDS, STOCK_THEMES, type StockThemeId } from '@talos-app/protocol'
import { useState } from 'react'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { getStockTheme, pickStockTheme, setStockTheme, useStockTheme } from '../../lib/theme.ts'
import { Button } from '../../ui/index.ts'
import { friendlyPatchError } from '../threads/manage/useThreadPatch.ts'

const SAVED_OFFLINE = 'Saved. It applies on your other devices when your Mac is back.'
const LABEL: Record<StockThemeId, string> = { talos: 'Talos', paper: 'Paper', hearth: 'Hearth' }

/** Four chips: the page, the card and the accent in light, and the page in dark. */
function Swatch({ id }: { id: StockThemeId }) {
  const t = STOCK_THEMES.find((x) => x.name === id)
  if (!t) return null
  const chips = [t.light['--bg'], t.light['--surface'], t.light['--accent'], t.dark['--bg']]
  return (
    <span
      data-testid="theme-swatch"
      aria-hidden="true"
      className="flex overflow-hidden rounded-button border border-line"
    >
      {chips.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: four fixed chips
        <span key={i} className="h-5 w-5" style={{ backgroundColor: c }} />
      ))}
    </span>
  )
}

export function ThemePicker({ readOnly }: { readOnly: boolean }) {
  const client = useTalosClient()
  const current = useStockTheme()
  const [note, setNote] = useState<{ kind: 'saved' | 'error'; text: string } | null>(null)
  const choose = async (id: StockThemeId) => {
    const before = getStockTheme()
    setNote(null)
    pickStockTheme(id)
    try {
      await client.patchConfig({ theme: id === 'talos' ? null : id })
    } catch (e) {
      if (e instanceof TalosClientError && e.code === 'mac_offline') {
        setNote({ kind: 'saved', text: SAVED_OFFLINE })
        return
      }
      setStockTheme(before)
      setNote({ kind: 'error', text: friendlyPatchError(e) })
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <h3 className="m-0 mt-2 text-base font-medium">Colour theme</h3>
      <div role="radiogroup" aria-label="Colour theme" className="flex flex-wrap gap-2">
        {STOCK_THEME_IDS.map((id) => (
          <Button
            key={id}
            role="radio"
            aria-checked={current === id}
            variant={current === id ? 'primary' : 'outline'}
            disabled={readOnly}
            onClick={() => void choose(id)}
          >
            <span className="flex items-center gap-2">
              <Swatch id={id} />
              {LABEL[id]}
            </span>
          </Button>
        ))}
      </div>
      <div>
        <Button variant="outline" disabled={readOnly || current === 'talos'} onClick={() => void choose('talos')}>
          Default theme
        </Button>
      </div>
      {current === 'custom' && (
        <p className="m-0 text-sm text-text-2">
          A custom theme your agent drafted is applied. Default theme goes back to Talos.
        </p>
      )}
      <p className="m-0 text-sm text-text-2">
        The same on all your devices. Light, dark and text size stay per device.
      </p>
      {note?.kind === 'error' && (
        <p role="alert" className="m-0 text-sm text-danger">
          {note.text}
        </p>
      )}
      {note?.kind === 'saved' && (
        <p role="status" className="m-0 text-sm text-text-2">
          {note.text}
        </p>
      )}
    </div>
  )
}
