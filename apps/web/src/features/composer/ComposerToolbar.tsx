// The row under the notices: + menu, the text box, and Send. On a phone the box takes a whole row of its own, the controls a
// row beneath it (+ left; Send right, always there, dimmed with nothing to send; the Report a bug button, on a phone, sits right beside
// +), so the text gets the full width (the owner, 2026-11-14). Once the thread's column is 36rem (576 px) wide it
// is one row again: the column's width (a container query), not the window's, so a narrow column beside the panes or the
// sidebar on a desktop gets the roomy layout too. Only the visual order changes (CSS order): the DOM, so the tab order
// and what a screen reader reads, stays plus, bug button, box, send.
// Voice input (Dictate, the mic, the live call) was archived on 2026-11-19. Send is always shown (2026-11-20), so the row keeps
// its height on a phone and the box does not change width as the first letter is typed.
import type { ChangeEvent, ClipboardEvent, KeyboardEvent, RefObject } from 'react'
import { cn } from '../../ui/cn.ts'
import { IconCamera, IconFile, IconImage, IconPlus, IconSend, IconStop } from '../../ui/icons.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/index.ts'
import { BugThreadButton } from '../bugreport/BugButton.tsx'
import type { useSlashPicker } from '../session/SlashPicker.tsx'
import type { WorkingStop } from '../threads/WorkingRow.tsx'
import { useSendGuard } from './sendGuard.ts'

type Which = 'photos' | 'camera' | 'files'

export function ComposerToolbar(p: {
  placeholder: string | undefined
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
  /** 'menu' (desktop): our popover over three inputs. 'native' (iPhone app): our popover over TalosPicker. 'ios-web'
   * (iPhone Safari): no popover, + opens iOS's own sheet on one plain input. */
  attachMode: 'native' | 'ios-web' | 'menu'
  openIosSheet: () => void
  canSend: boolean
  /** An attachment is still uploading: Send waits for it, and a tap says so. */
  waiting: boolean
  tooLong: boolean
  /** Stop for the turn that is running (hidden when there is none to stop). */
  working: WorkingStop
  onSend: () => void
}) {
  const { text, picker } = p
  const sendGuard = useSendGuard(p.canSend)
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
      {p.attachMode === 'ios-web' ? (
        <button
          type="button"
          aria-label="Attach"
          onClick={p.openIosSheet}
          className="order-2 grid size-[min(2.75rem,52px)] shrink-0 place-items-center rounded-pill text-text-2 @min-[36rem]:order-none"
        >
          <IconPlus />
        </button>
      ) : (
        <Popover open={p.menuOpen} onOpenChange={p.setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Attach"
              className="order-2 grid size-[min(2.75rem,52px)] shrink-0 place-items-center rounded-pill text-text-2 @min-[36rem]:order-none"
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
      )}

      {/* Report a bug (placement B, phones only): beside +. Same order slot as Send's, ahead of it in the DOM. */}
      <BugThreadButton variant="inline" className="order-3 @min-[36rem]:order-none" />

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

      {/* Send's slot: as wide and as high as Send, whether or not there is anything to send, so nothing moves. */}
      <div className="order-4 ms-auto flex min-h-[min(2.75rem,52px)] min-w-[min(2.75rem,52px)] items-end gap-2 @min-[36rem]:order-none @min-[36rem]:ms-0">
        {p.working.showStop && (
          // Stop sits left of Send, which stays put; the guard still swallows a press there in the moment after a send (sendGuard.ts)
          <div className="contents" {...sendGuard.handlers}>
            <button
              type="button"
              aria-label="Stop"
              data-testid="composer-stop"
              disabled={p.working.busy}
              // keeps the keyboard up: a tap must not pull focus off the box
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void p.working.stop()}
              className="grid size-[min(2.75rem,52px)] shrink-0 place-items-center rounded-pill border border-danger text-danger disabled:opacity-40"
            >
              <IconStop fill="currentColor" />
            </button>
          </div>
        )}
        {/* Send is always here (the owner, 2026-11-20: "there's no button to hit Send"). With nothing to send, or an upload
            still running, it is dimmed and does nothing; typing turns it on where it already is. */}
        <button
          type="button"
          aria-label="Send"
          aria-disabled={!p.canSend || p.tooLong || undefined}
          // A click must not pull focus off the box.
          onMouseDown={(e) => e.preventDefault()}
          title={p.waiting ? 'Waiting for the upload' : undefined}
          data-waiting={p.waiting || undefined}
          onClick={(e) => {
            if (!p.canSend) {
              if (p.waiting) p.onSend() // sends nothing: the box says it is waiting for the upload
              return
            }
            sendGuard.sent(e)
            p.onSend()
            // From the keyboard (Enter or Space on Send: detail 0) focus goes back to the box, so a second Enter or Space lands
            // in the box
            if (e.detail === 0) p.taRef.current?.focus({ preventScroll: true })
          }}
          className={cn(
            'grid size-[min(2.75rem,52px)] shrink-0 place-items-center rounded-pill bg-accent text-on-accent transition-opacity duration-[var(--dur-1)]',
            (!p.canSend || p.tooLong) && 'opacity-40',
          )}
        >
          {p.waiting ? (
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              width="20"
              height="20"
              className="animate-spin motion-reduce:animate-none"
            >
              <circle
                cx="12"
                cy="12"
                r="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeDasharray="42 100"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <IconSend />
          )}
        </button>
      </div>
    </div>
  )
}
