// Settings > Developer: one switch per guard, drawn from DEV_ROWS (packages/protocol/src/dev.ts), plus "Developer mode", which sets
// every row to its open value at once (the owner's ruling 2026-11-15). Each tap is one owner-signed config.patch with no card;
// the switch follows the saved config, so a refused change leaves it where it was.
import { DEV_ROWS, type DevRow, OS_SANDBOX_LEAD, OS_SANDBOX_LIMITS, OS_SANDBOX_TITLE } from '@talos-app/protocol'
import { useId, useRef, useState } from 'react'
import { TalosClientError, useTalos, useTalosClient } from '../../lib/client.ts'
import { placeWords, useHost } from '../../lib/hostWords.ts'
import { Switch } from '../../ui/index.ts'
import { connectionRefusal, friendlyPatchError } from '../threads/manage/useThreadPatch.ts'
import { useWriteBlock } from './offline.ts'
import type { SectionProps } from './sections.tsx'

export const DEVELOPER_TEXT = {
  intro: "These switches loosen Talos's guards. Leave them as they are unless you are working on Talos.",
  modeLabel: 'Developer mode',
  modeHelp: (when: string) =>
    `Opens the guards below in one tap; each one can still be changed on its own. Turning it off puts them back to their defaults. Takes effect ${when}.`,
  update: 'Update Talos on your Mac to change this.',
} as const

type Values = Record<DevRow['key'], boolean>

/** The rows Developer mode moves: only where the open setting differs from the default (a row like the notes lookup is the owner's own). */
const MODE_ROWS = DEV_ROWS.filter((r) => r.open !== r.default)
const MODE_WHEN = [...new Set(MODE_ROWS.map((r) => r.when))].join(' and ')

/** The bridge's reading: a default-on row is on unless the literal false; a default-off row is on only for the literal true. */
function devValue(config: { dev?: Partial<Record<DevRow['key'], unknown>> } | null, row: DevRow): boolean {
  const v = config?.dev?.[row.key]
  return row.default ? v !== false : v === true
}

const allAt = (pick: (r: DevRow) => boolean): Values =>
  Object.fromEntries(MODE_ROWS.map((r) => [r.key, pick(r)])) as Values

export function DeveloperSection(_p: SectionProps) {
  const client = useTalosClient()
  const config = useTalos((s) => s.config)
  const block = useWriteBlock()
  const host = useHost()
  const modeId = useId()
  const modeDescId = useId()
  const [busy, setBusy] = useState(false)
  const saving = useRef(false) // state lags a same-tick second tap
  const [err, setErr] = useState<string | null>(null)
  if (!config) return null
  const open = MODE_ROWS.every((r) => devValue(config, r) === r.open)

  const write = async (dev: Partial<Values>) => {
    if (busy || saving.current) return // never disabled while saving: a disabled control drops keyboard focus on some phones
    setErr(null)
    saving.current = true
    setBusy(true)
    try {
      await client.patchConfig({ dev })
    } catch (e) {
      setErr(
        connectionRefusal(e) ??
          (e instanceof TalosClientError && e.code === 'config_field_forbidden'
            ? placeWords(DEVELOPER_TEXT.update, host)
            : friendlyPatchError(e)),
      )
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  // the experimental lock is a top-level setting (`os_sandbox`), not one under `dev`: one owner-signed patch, like the rows above
  const writeTop = async (patch: { os_sandbox: boolean }) => {
    if (busy || saving.current) return
    setErr(null)
    saving.current = true
    setBusy(true)
    try {
      await client.patchConfig(patch)
    } catch (e) {
      setErr(
        connectionRefusal(e) ??
          (e instanceof TalosClientError && e.code === 'config_field_forbidden'
            ? placeWords(DEVELOPER_TEXT.update, host)
            : friendlyPatchError(e)),
      )
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="developer" className="flex flex-col gap-4" data-testid="developer">
      <h2 id="developer" className="m-0 text-base font-semibold">
        Developer
      </h2>
      <p className="m-0 text-text-2">{DEVELOPER_TEXT.intro}</p>
      {MODE_ROWS.length > 0 && ( // with no row to open, a master switch would show on and do nothing
        <div className="flex flex-col gap-1" data-testid="dev-mode">
          <div className="flex min-h-11 items-center justify-between gap-3">
            <label htmlFor={modeId} className="text-base font-medium">
              {DEVELOPER_TEXT.modeLabel}
            </label>
            <Switch
              id={modeId}
              checked={open}
              disabled={block !== null}
              aria-busy={busy}
              aria-describedby={modeDescId}
              onCheckedChange={(v) => void write(allAt((r) => (v ? r.open : r.default)))}
            />
          </div>
          <p id={modeDescId} className="m-0 text-text-2">
            {DEVELOPER_TEXT.modeHelp(MODE_WHEN)}
          </p>
        </div>
      )}
      {DEV_ROWS.map((row) => (
        <DevRowSwitch
          key={row.key}
          row={row}
          on={devValue(config, row)}
          busy={busy}
          disabled={block !== null}
          onSet={(v) => void write({ [row.key]: v })}
        />
      ))}
      <SandboxRow
        on={config.os_sandbox === true}
        busy={busy}
        disabled={block !== null}
        onSet={(v) => void writeTop({ os_sandbox: v })}
      />
      {block === 'mac' && (
        <p className="m-0 text-text-2">{placeWords('Your Mac has to be online to change this.', host)}</p>
      )}
      {err && (
        <p role="alert" className="m-0 text-danger">
          {err}
        </p>
      )}
    </section>
  )
}

function DevRowSwitch(p: { row: DevRow; on: boolean; busy: boolean; disabled: boolean; onSet: (v: boolean) => void }) {
  const id = useId()
  const descId = useId()
  const host = useHost()
  return (
    <div className="flex flex-col gap-1" data-testid={`dev-row-${p.row.key}`}>
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={id} className="text-base font-medium">
          {p.row.title}
        </label>
        <Switch
          id={id}
          checked={p.on}
          disabled={p.disabled}
          aria-busy={p.busy}
          aria-describedby={descId}
          onCheckedChange={p.onSet}
        />
      </div>
      <p id={descId} className="m-0 text-text-2">
        {placeWords(p.on ? p.row.on : p.row.off, host)} Takes effect {p.row.when}.
      </p>
    </div>
  )
}

/** "Extra lock on protected files (experimental)": off by default; what it does not stop is said right under it, in short plain lines. */
function SandboxRow(p: { on: boolean; busy: boolean; disabled: boolean; onSet: (v: boolean) => void }) {
  const id = useId()
  const descId = useId()
  return (
    <div className="flex flex-col gap-1" data-testid="dev-row-os_sandbox">
      <div className="flex min-h-11 items-center justify-between gap-3">
        <label htmlFor={id} className="text-base font-medium">
          {OS_SANDBOX_TITLE}
        </label>
        <Switch
          id={id}
          checked={p.on}
          disabled={p.disabled}
          aria-busy={p.busy}
          aria-describedby={descId}
          onCheckedChange={p.onSet}
        />
      </div>
      <div id={descId} className="flex flex-col gap-1 text-text-2">
        <p className="m-0">
          {p.on
            ? "On: your agent and its threads start inside an OS sandbox that tries to keep them from changing Talos's own settings files."
            : 'Off: a start has no OS sandbox.'}{' '}
          Takes effect at the next start of your agent and of each thread.
        </p>
        <p className="m-0">{OS_SANDBOX_LEAD}</p>
        <ul className="m-0 list-disc pl-5">
          {OS_SANDBOX_LIMITS.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  )
}
