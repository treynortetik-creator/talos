// The row under the notices: + menu, the text box (or the recording indicator), dictation, and Send / mic / live call.
// On a phone the box takes a whole row of its own, the controls a row beneath it (+ and dictation left; mic, live call or
// Send right), so the text gets the full width (the owner, 2026-11-14). Once the thread's column is 36rem (576 px) wide it
// is one row again: the column's width (a container query), not the window's, so a narrow column beside the panes or the
// sidebar on a desktop gets the roomy layout too. Only the visual order changes (CSS order): the DOM, so the tab order
// and what a screen reader reads, stays plus, box, dictation, send.
import { type ChangeEvent, type ClipboardEvent, type KeyboardEvent, type RefObject, Suspense } from 'react'
import { formatDuration } from '../../lib/format.ts'
import { cn } from '../../ui/cn.ts'
import { IconCamera, IconFile, IconImage, IconMic, IconPlus, IconSend } from '../../ui/icons.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/index.ts'
import { LiveCallButton } from '../registry.ts'
import type { useSlashPicker } from '../session/SlashPicker.tsx'
import type { Mode } from './useComposerVoice.ts'

type Which = 'photos' | 'camera' | 'files'

export function ComposerToolbar(p: {
  threadId: string
  placeholder: string | undefined
  mode: Mode
  hint: 'slide' | 'cancel' | 'lock' | null
  elapsed: number
  text: string
  setText: (v: string) => void
  clearNote: () => void
  taRef: RefObject<HTMLTextAreaElement | null>
  syncFromDom: () => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  picker: ReturnType<typeof useSlashPicker>
  menuOpen: boolean
  setMenuOpen: (open: boolean) => void
  choseOnce: { current: boolean }
  pickerRef: (which: Which) => (n: HTMLInputElement | null) => void
  onPick: (e: ChangeEvent<HTMLInputElement>) => void
  choosePicker: (which: Which) => void
  dictationButton: React.ReactNode
  dictationBusy: boolean
  canSend: boolean
  tooLong: boolean
  macOnline: boolean
  onSend: () => void
  mic: {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => void
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onMicClick: (e: React.MouseEvent) => void
  }
}) {
  const { mode, hint, elapsed, text, picker, dictationBusy } = p
  const recording = mode !== 'idle'
  return (
    <div data-testid="composer-row" className="flex flex-wrap items-end gap-x-2 gap-y-1.5 @min-[36rem]:flex-nowrap">
      <input
        ref={p.pickerRef('photos')}
        data-testid="pick-photos"
        type="file"
        accept="image/*"
        multiple
        hidden
        tabIndex={-1}
        onChange={p.onPick}
      />
      <input
        ref={p.pickerRef('camera')}
        data-testid="pick-camera"
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        tabIndex={-1}
        onChange={p.onPick}
      />
      <input
        ref={p.pickerRef('files')}
        data-testid="pick-files"
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={p.onPick}
      />
      <Popover open={p.menuOpen} onOpenChange={p.setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Attach"
            className="order-2 grid size-[min(2.75rem,52px)] shrink-0 place-items-center rounded-pill text-text-2 @min-[36rem]:order-none"
            disabled={recording}
          >
            <IconPlus />
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label="Attach"
          className="flex w-56 flex-col gap-1 p-1"
          // After a choice the OS picker takes over (no focus grab, it would raise the keyboard under it); a plain
          // dismissal returns focus to the + button like any menu.
          onCloseAutoFocus={(e) => {
            if (!p.choseOnce.current) return
            p.choseOnce.current = false
            e.preventDefault()
          }}
        >
          {(
            [
              ['photos', IconImage, 'Photo library'],
              ['camera', IconCamera, 'Camera'],
              ['files', IconFile, 'Files'],
            ] as const
          ).map(([which, Icon, label]) => (
            <button
              key={which}
              type="button"
              data-testid={`attach-${which}`}
              onClick={() => p.choosePicker(which)}
              className="flex min-h-11 items-center gap-3 rounded-button px-3 text-left hover:bg-surface-2"
            >
              <Icon /> {label}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      {recording ? (
        <div
          className="order-1 flex min-h-11 basis-full items-center gap-3 px-2 @min-[36rem]:order-none @min-[36rem]:flex-1 @min-[36rem]:basis-auto"
          aria-live="polite"
        >
          <span className="inline-block size-2 rounded-pill bg-danger" aria-hidden="true" />
          <span className="font-mono text-sm">{formatDuration(elapsed)}</span>
          <span className="text-sm text-text-2">
            {hint === 'cancel' ? 'Release to cancel' : hint === 'lock' ? 'Release to lock' : '‹ Slide to cancel'}
          </span>
        </div>
      ) : (
        <textarea
          ref={p.taRef}
          value={text}
          rows={1}
          onChange={(e) => {
            p.setText(e.target.value)
            p.clearNote()
          }}
          onInput={p.syncFromDom}
          onBeforeInput={p.syncFromDom}
          onFocus={p.syncFromDom}
          onBlur={p.syncFromDom}
          onCompositionEnd={p.syncFromDom}
          onKeyUp={p.syncFromDom}
          onKeyDown={p.onKeyDown}
          onPaste={p.onPaste}
          placeholder={p.placeholder ?? 'Message'}
          aria-label="Message"
          {...(picker.open && picker.items.length > 0
            ? { 'aria-controls': 'slash-list', 'aria-activedescendant': picker.items[picker.active]?.id }
            : {})}
          enterKeyHint="send"
          className="composer-box order-1 max-h-64 min-h-11 min-w-0 basis-full resize-none @min-[36rem]:order-none @min-[36rem]:flex-1 @min-[36rem]:basis-auto rounded-bubble border border-line bg-surface px-[min(1rem,18px)] py-[0.65rem] text-text transition-[border-color,box-shadow] duration-[var(--dur-1)] ease-talos placeholder:text-text-2 focus-visible:border-text focus-visible:shadow-[0_0_0_1px_var(--text)] focus-visible:outline-none"
        />
      )}

      {!recording && p.dictationButton ? (
        <div className="order-3 flex @min-[36rem]:order-none">{p.dictationButton}</div>
      ) : null}

      <div className="order-4 ms-auto flex items-end gap-2 @min-[36rem]:order-none @min-[36rem]:ms-0">
        {p.canSend && !recording ? (
          <button
            type="button"
            aria-label="Send"
            aria-disabled={p.tooLong || undefined}
            // A click must not pull focus off the box (the button also unmounts once the text empties).
            onMouseDown={(e) => e.preventDefault()}
            onClick={p.onSend}
            className={cn(
              'grid size-[min(2.75rem,52px)] shrink-0 place-items-center rounded-pill bg-accent text-on-accent',
              p.tooLong && 'opacity-40',
            )}
          >
            <IconSend />
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-label="Record a voice note"
              data-testid="mic"
              disabled={dictationBusy}
              onPointerDown={p.mic.onPointerDown}
              onPointerMove={p.mic.onPointerMove}
              onPointerUp={p.mic.onPointerUp}
              onPointerCancel={p.mic.onPointerCancel}
              onClick={p.mic.onMicClick}
              onContextMenu={(e) => e.preventDefault()}
              style={{ touchAction: 'none' }}
              className={cn(
                'grid size-[min(2.75rem,52px)] shrink-0 select-none place-items-center rounded-pill',
                mode === 'holding' ? 'scale-125 bg-accent text-on-accent' : 'text-text-2',
                dictationBusy && 'opacity-40',
              )}
            >
              <IconMic />
            </button>
            {!recording && text === '' && (
              <Suspense fallback={null}>
                <LiveCallButton threadId={p.threadId} disabled={!p.macOnline || dictationBusy} />
              </Suspense>
            )}
          </>
        )}
      </div>
    </div>
  )
}
