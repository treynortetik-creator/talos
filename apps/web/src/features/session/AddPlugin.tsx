// "Add a plugin to your agent" in Settings > Session > Plugins: two plain fields and one signed `plugin.add.request`. The bridge answers with ONE card
// (the owner approves it there: it lists the plugin's hooks and says plainly when it can approve tool calls without asking the phone) or says why not.
// Shown only when the relay lists plugin-add/1. The wait ends with the form: closing it stops listening, and a late answer is dropped.
import { type FrameOf, newUlid, PLUGIN_ADD_FEATURE, PluginName } from '@talos-app/protocol'
import { useEffect, useRef, useState } from 'react'
import { TalosClientError, useTalosClient } from '../../lib/client.ts'
import { useFeature } from '../../lib/v2Client.ts'
import { PLUGIN_WEB_WORDS as W } from './pluginWords.ts'

const WAIT_MS = 30_000

export function AddPlugin() {
  const client = useTalosClient()
  const feature = useFeature(PLUGIN_ADD_FEATURE)
  const [plugin, setPlugin] = useState('')
  const [market, setMarket] = useState('')
  const [asking, setAsking] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const waiting = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const done = useRef<(text: string) => void>(() => {})
  done.current = (text) => {
    if (waiting.current) clearTimeout(waiting.current.timer)
    waiting.current = null
    setAsking(false)
    setSaid(text)
  }

  useEffect(() => {
    const off = client.onFrame('plugin.add.result', (f: FrameOf<'plugin.add.result'>) => {
      if (waiting.current?.id === f.control_id) done.current(f.text)
    })
    return () => {
      off()
      if (waiting.current) clearTimeout(waiting.current.timer)
      waiting.current = null
    }
  }, [client])

  if (feature !== 'on') return null

  const valid = PluginName.safeParse(plugin.trim()).success && PluginName.safeParse(market.trim()).success
  const ask = async () => {
    if (waiting.current) return
    setSaid(null)
    if (!valid) return setSaid(W.badName)
    if (!client.sendOwnerFrame) return setSaid(W.noClient)
    const send = client.sendOwnerFrame.bind(client)
    const control_id = newUlid()
    setAsking(true)
    waiting.current = { id: control_id, timer: setTimeout(() => done.current(W.slow), WAIT_MS) }
    try {
      await send({ type: 'plugin.add.request', control_id, plugin: plugin.trim(), marketplace: market.trim() })
    } catch (e) {
      if (waiting.current?.id !== control_id) return
      done.current(e instanceof TalosClientError && e.code === 'mac_offline' ? W.macOffline : W.noClient)
    }
  }

  return (
    <section data-testid="add-plugin" className="mt-3 border-t border-line pt-3">
      <h3 className="m-0 text-sm font-medium">{W.addTitle}</h3>
      <p className="m-0 mt-1 text-sm text-text-2">{W.addHelp}</p>
      <div className="mt-2 flex flex-col gap-2">
        <label className="text-sm">
          {W.pluginLabel}
          <input
            value={plugin}
            onChange={(e) => setPlugin(e.target.value)}
            maxLength={64}
            autoCapitalize="none"
            autoCorrect="off"
            className="mt-1 block min-h-11 w-full rounded-input border border-line bg-surface px-3"
          />
        </label>
        <label className="text-sm">
          {W.marketLabel}
          <input
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            maxLength={64}
            autoCapitalize="none"
            autoCorrect="off"
            className="mt-1 block min-h-11 w-full rounded-input border border-line bg-surface px-3"
          />
        </label>
        <button
          type="button"
          onClick={() => void ask()}
          className="min-h-11 rounded-button bg-accent px-4 text-on-accent"
          data-testid="add-plugin-button"
        >
          {asking ? W.sending : W.addButton}
        </button>
        {said && (
          <p role="status" className="m-0 text-sm text-text-2" data-testid="add-plugin-said">
            {said}
          </p>
        )}
      </div>
    </section>
  )
}
