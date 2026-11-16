// The bug reporter on a phone: full screen. Cancel, the title and Send on one line under the status bar, the picture, one row
// of tools, the words, and one row for what is attached. Preview opens the tick box for each automatic part and the exact
// text that will be sent. The phone draws in the first ink; it has no ink picker.
import { Button, DialogDescription, DialogTitle } from '../../ui/index.ts'
import { CheckRow, PicturePane, PreviewBox, SendStatus, WentWrong } from './Parts.tsx'
import { Tools } from './Tools.tsx'
import { BUG_TEXT } from './text.ts'
import type { Reporter } from './useReporter.ts'

export function PhoneLayout({ r }: { r: Reporter }) {
  const unavailable = r.ctxState === 'unavailable'
  return (
    <>
      <header
        data-testid="bug-phone-header"
        // three columns so the title stays centred whatever Send says
        className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 pt-[max(0.75rem,env(safe-area-inset-top))]"
      >
        <Button variant="ghost" onClick={r.close} className="justify-self-start px-1 text-[15px] text-text-2">
          {r.sent ? BUG_TEXT.done : BUG_TEXT.phone.cancel}
        </Button>
        <DialogTitle className="min-w-0 truncate text-center text-[17px]">{BUG_TEXT.title}</DialogTitle>
        <DialogDescription className="sr-only">{BUG_TEXT.screenshotTaken(r.time, r.where)}</DialogDescription>
        <Button
          variant="ghost"
          onClick={r.send}
          disabled={r.sending || r.sent || r.gathering}
          className="justify-self-end px-1 text-right text-[15px] font-semibold text-accent-text"
        >
          {r.sending ? BUG_TEXT.sending : r.gathering ? BUG_TEXT.gathering : BUG_TEXT.phone.send}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <PicturePane r={r} fit />
          <Tools
            layout="row"
            tool={r.tool}
            setTool={r.setTool}
            ink={r.ink}
            setInk={r.setInk}
            canUndo={r.marks.length > 0}
            undo={r.undo}
          />
          <WentWrong r={r} rows={3} />
          <div className="flex min-h-11 items-center justify-between gap-3 rounded-button bg-surface-2 px-3 text-sm text-text-2">
            <span id={`${r.ids.m}-row`}>{BUG_TEXT.phone.previewRow}</span>
            <button
              type="button"
              aria-expanded={r.showPreview}
              aria-describedby={`${r.ids.m}-row`}
              onClick={r.togglePreview}
              className="min-h-11 shrink-0 rounded-button px-1 text-accent-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {BUG_TEXT.phone.previewAction}
            </button>
          </div>
          {unavailable ? <p className="-mt-2 text-xs text-text-2">{BUG_TEXT.unavailable}</p> : null}
          {r.showPreview ? (
            <section aria-labelledby={`${r.ids.m}-h`} className="flex flex-col">
              <h3 id={`${r.ids.m}-h`} className="mb-1 text-sm font-semibold">
                {BUG_TEXT.attached}
              </h3>
              <CheckRow r={r} k="versions" label={BUG_TEXT.versions} touch />
              <CheckRow r={r} k="thread" label={BUG_TEXT.threadScreen} touch />
              <CheckRow r={r} k="errors" label={BUG_TEXT.recentErrors(r.errorCount)} touch />
              <CheckRow r={r} k="logs" label={BUG_TEXT.logs} touch />
              <CheckRow r={r} k="messages" label={BUG_TEXT.messages} disabled={!r.hasThread} touch />
            </section>
          ) : null}
          <PreviewBox r={r} />
          <SendStatus r={r} />
          <p className="text-xs leading-normal text-text-2">{BUG_TEXT.phone.privacy}</p>
          <p className="text-xs leading-normal text-text-2" data-testid="bug-goes-to">
            {r.goesTo}
          </p>
        </div>
      </div>
    </>
  )
}
