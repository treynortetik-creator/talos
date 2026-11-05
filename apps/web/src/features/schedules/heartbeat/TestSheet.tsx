// The Heartbeat test sheet (docs/HEARTBEAT.md "Test run"): sends `heartbeat.test`, waits for the result, and shows what the
// heartbeat would do. [Turn on] is enabled only by a result that is for THIS config, fresh, and clean (heartbeatTestPassed);
// a failed, missing, older or other-config result leaves it disabled whatever the screen looks like.
import {
  HEARTBEAT_TEST_WAIT_MS,
  HEARTBEAT_TEST_WINDOWS_H,
  type HeartbeatConfigT,
  type HeartbeatTestResultT,
} from '@talos-app/protocol'
import { useState } from 'react'
import { useTalos } from '../../../lib/client.ts'
import { cn } from '../../../ui/cn.ts'
import { Button, Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '../../../ui/index.ts'
import { useNow } from '../../cards/util.ts'
import { KIND_WORDS } from './logic.ts'
import { useHeartbeatTest } from './testStore.ts'
import { useRestoreFocus } from './useRestoreFocus.ts'

const tokens = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`)

export function Result({ r, config }: { r: HeartbeatTestResultT; config: HeartbeatConfigT }) {
  const kinds = new Map(config.sources.map((s) => [s.id, s]))
  // the mode the Mac tested; an older Mac says nothing, then it is the mode of the settings being tested
  const shadow = (r.mode ?? config.mode) === 'shadow'
  const live = r.if_live
  return (
    <div className="flex flex-col gap-3" data-testid="test-result">
      {r.error ? (
        <p role="alert" className="m-0 text-sm text-danger" data-testid="test-error">
          {r.error}
        </p>
      ) : null}
      {shadow ? (
        <p className="m-0 text-sm font-medium" data-testid="test-shadow">
          Shadow: records only, never wakes or posts
        </p>
      ) : null}
      <ul className="m-0 list-none space-y-1.5 p-0" aria-label="Sources tested">
        {r.sources.map((s) => (
          <li key={s.id} className="text-sm" data-testid={`test-source-${s.id}`}>
            <span
              className={cn('font-medium', s.ok && s.unreadable === 0 ? 'text-ok' : s.ok ? 'text-warn' : 'text-danger')}
            >
              <span aria-hidden="true">{s.ok && s.unreadable === 0 ? '✓' : s.ok ? '!' : '✕'}</span>{' '}
              {kinds.get(s.id) ? KIND_WORDS[kinds.get(s.id)?.kind as keyof typeof KIND_WORDS] : s.id}
              <span className="sr-only">{s.ok ? (s.unreadable ? ' partly read' : ' ok') : ' failed'}</span>
            </span>
            {s.ok ? (
              <span className="text-text-2">
                {' '}
                {(s.ms / 1000).toFixed(1)} s · {s.read} read · {s.act} act · {s.held} hold · {s.dropped} dropped
                {s.unreadable ? ` · ${s.unreadable} couldn't be read` : ''}
              </span>
            ) : (
              <span className="block text-text-2">{s.error ?? 'It did not answer.'}</span>
            )}
          </li>
        ))}
      </ul>
      {r.unreadable_rows > 0 ? (
        <p role="alert" className="m-0 text-sm text-warn">
          {r.unreadable_rows} {r.unreadable_rows === 1 ? 'result' : 'results'} from your Mac couldn't be read. Update
          the app, then test again.
        </p>
      ) : null}
      {r.would_wake.length > 0 ? (
        <div className="text-sm">
          <p className="m-0 font-medium">Would wake the agent for {r.would_wake.length}:</p>
          <ul className="m-0 list-none space-y-0.5 p-0 text-text-2">
            {r.would_wake.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list shown once
              <li key={i}>
                {l.title}
                {l.why ? ` (why: ${l.why})` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.would_post.length > 0 ? (
        <div className="text-sm">
          <p className="m-0 font-medium">Would post {r.would_post.length}:</p>
          <ul className="m-0 list-none space-y-0.5 p-0 text-text-2">
            {r.would_post.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list shown once
              <li key={i}>{l.title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {shadow && live && (live.would_wake.length > 0 || live.would_post.length > 0) ? (
        <p className="m-0 text-sm text-text-2" data-testid="test-if-live">
          If live: would wake the agent for {live.would_wake.length}, would post {live.would_post.length}.
        </p>
      ) : null}
      {r.sources.every((s) => s.ok) &&
      r.would_wake.length === 0 &&
      r.would_post.length === 0 &&
      r.held === 0 &&
      !r.error &&
      !(shadow && live && (live.would_wake.length > 0 || live.would_post.length > 0)) ? (
        <p className="m-0 text-sm text-text-2" data-testid="test-empty">
          Nothing needed you in the last {r.window_h} hours. That counts as a pass.
        </p>
      ) : null}
      {r.held > 0 ? <p className="m-0 text-sm text-text-2">Held for the morning brief: {r.held}</p> : null}
      {r.est_wakes !== null ? (
        <p className="m-0 text-sm text-text-2">
          Estimated: {r.est_wakes} {r.est_wakes === 1 ? 'wake' : 'wakes'} a day
          {r.est_tokens ? `, about ${tokens(r.est_tokens)} fresh tokens` : ''}.
        </p>
      ) : null}
    </div>
  )
}

export function TestSheet({
  config,
  hash,
  onClose,
  onTurnOn,
  turnOnLabel = 'Turn on',
}: {
  config: HeartbeatConfigT
  /** configHash of `config`; the test and the pass are bound to it. */
  hash: string
  onClose: () => void
  /** Called only when the gate is open. */
  onTurnOn: () => void
  turnOnLabel?: string
}) {
  const macOnline = useTalos((s) => s.presence.bridge_online)
  const now = useNow(30_000)
  const [windowH, setWindowH] = useState<number>(24)
  const t = useHeartbeatTest(hash)
  const restore = useRestoreFocus()
  const running = t.entry?.running === true
  const passed = t.passed(config, now)
  const result = t.entry?.result ?? null
  const failedSources = result ? result.sources.filter((s) => !s.ok || s.unreadable > 0) : []
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent aria-describedby="hb-test-desc" data-testid="heartbeat-test-sheet" {...restore}>
        <SheetTitle className="font-display text-lg font-semibold">Test run</SheetTitle>
        <SheetDescription id="hb-test-desc" className="mt-1 text-sm text-text-2">
          Reads your sources for real and posts, wakes and saves nothing.
        </SheetDescription>
        <fieldset className="m-0 mt-3 flex flex-wrap items-center gap-2 border-0 p-0" aria-label="Look back">
          {HEARTBEAT_TEST_WINDOWS_H.map((h) => (
            <Button
              key={h}
              variant={windowH === h ? 'primary' : 'outline'}
              aria-pressed={windowH === h}
              disabled={running}
              onClick={() => setWindowH(h)}
            >
              {h} h
            </Button>
          ))}
        </fieldset>
        <div className="mt-3 space-y-3" aria-live="polite">
          {running ? (
            <p role="status" data-testid="test-running" className="m-0 text-sm text-text-2">
              Testing… this can take up to {Math.round(HEARTBEAT_TEST_WAIT_MS / 60_000 + 0.5)} minutes.
            </p>
          ) : null}
          {t.entry?.failure ? (
            <p role="alert" data-testid="test-failed" className="m-0 text-sm text-danger">
              {t.entry.failure}
            </p>
          ) : null}
          {t.entry?.retest && !running ? (
            <p role="alert" data-testid="test-retest-failed" className="m-0 text-sm text-warn">
              {t.entry.retest} The earlier result below is still the latest one.
            </p>
          ) : null}
          {result ? (
            <Result r={result} config={config} />
          ) : !running && !t.entry?.failure ? (
            <p className="m-0 text-sm text-text-2" data-testid="test-none">
              Not tested yet. Turn on needs a passing test of exactly these settings.
            </p>
          ) : null}
          {result && !passed ? (
            <p role="status" data-testid="test-not-passed" className="m-0 text-sm text-warn">
              {result.config_hash !== hash
                ? 'That result was for different settings. Test again.'
                : failedSources.length > 0
                  ? `Fix ${failedSources.map((s) => s.id).join(', ')}, or turn it off, then test again.`
                  : 'This result is too old or not complete. Test again.'}
            </p>
          ) : null}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!macOnline || running}
            onClick={() => void t.run(config, { windowH, withAgent: false })}
          >
            {result || t.entry?.failure ? 'Test again' : 'Run test'}
          </Button>
          <Button disabled={!passed || !macOnline || running} onClick={onTurnOn}>
            {turnOnLabel}
          </Button>
        </div>
        {!macOnline ? <p className="mt-2 text-sm text-text-2">Your Mac is offline. A test needs it.</p> : null}
        <SheetClose className="mt-3 min-h-11 text-sm text-text-2 underline">Close</SheetClose>
      </SheetContent>
    </Sheet>
  )
}
