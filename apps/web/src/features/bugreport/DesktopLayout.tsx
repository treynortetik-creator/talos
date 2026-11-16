// The bug reporter on a computer: the tools down the left, the picture in the middle, the words and what is attached on the right.
import { BUG_REPORT_LIMITS } from '@talos-app/protocol'
import { IconBug, IconClose, IconShield } from '../../ui/icons.tsx'
import { Button, DialogDescription, DialogTitle, Textarea } from '../../ui/index.ts'
import { CheckRow, PicturePane, PreviewBox, SendStatus, WentWrong } from './Parts.tsx'
import { Tools } from './Tools.tsx'
import { BUG_TEXT } from './text.ts'
import type { Reporter } from './useReporter.ts'

export function DesktopLayout({ r }: { r: Reporter }) {
  const unavailable = r.ctxState === 'unavailable' ? ` · ${BUG_TEXT.unavailable}` : ''
  return (
    <>
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-line px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-button bg-accent text-on-accent">
            <IconBug width={18} height={18} strokeWidth={2.2} />
          </span>
          <DialogTitle className="shrink-0 text-lg">{BUG_TEXT.title}</DialogTitle>
          <DialogDescription className="mt-0 truncate text-sm text-text-2">
            {BUG_TEXT.screenshotTaken(r.time, r.where)}
          </DialogDescription>
        </div>
        <Button variant="outline" aria-label={BUG_TEXT.close} onClick={r.close} className="px-0">
          <IconClose width={18} height={18} strokeWidth={2} />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="w-[72px] shrink-0 overflow-y-auto border-r border-line py-4">
          <Tools
            layout="column"
            tool={r.tool}
            setTool={r.setTool}
            ink={r.ink}
            setInk={r.setInk}
            canUndo={r.marks.length > 0}
            undo={r.undo}
          />
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-auto bg-bg p-6">
          <div className="m-auto flex w-full max-w-[56rem] flex-col gap-3">
            <PicturePane r={r} />
          </div>
        </div>

        <div className="flex w-[clamp(18.75rem,34vw,23.75rem)] shrink-0 flex-col border-l border-line">
          <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-6">
            <WentWrong r={r} rows={4} />
            <div className="flex flex-col gap-2">
              <label htmlFor={r.ids.e} className="text-sm font-semibold">
                {BUG_TEXT.expected}
                <span className="font-normal text-text-2"> {BUG_TEXT.optional}</span>
              </label>
              <Textarea
                id={r.ids.e}
                rows={2}
                value={r.expected}
                maxLength={BUG_REPORT_LIMITS.expectedChars}
                onChange={(e) => r.setExpected(e.target.value)}
                className="min-h-0 resize-none"
              />
            </div>

            <section aria-labelledby={`${r.ids.m}-h`} className="flex flex-col">
              <h3 id={`${r.ids.m}-h`} className="mb-1 text-sm font-semibold">
                {BUG_TEXT.attached}
              </h3>
              <CheckRow r={r} k="versions" label={BUG_TEXT.versions} />
              <CheckRow r={r} k="thread" label={BUG_TEXT.threadScreen} />
              <CheckRow r={r} k="errors" label={`${BUG_TEXT.recentErrors(r.errorCount)}${unavailable}`} />
              <CheckRow r={r} k="logs" label={BUG_TEXT.logs} />
              <CheckRow r={r} k="messages" label={BUG_TEXT.messages} disabled={!r.hasThread} />
              <button
                type="button"
                aria-expanded={r.showPreview}
                onClick={r.togglePreview}
                className="min-h-11 self-start rounded-button text-left text-sm text-accent-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {BUG_TEXT.preview}
              </button>
            </section>
            <PreviewBox r={r} />

            <div className="flex items-start gap-2.5 rounded-button bg-surface-2 p-3 text-xs leading-normal text-text-2">
              <IconShield width={16} height={16} className="mt-0.5 shrink-0" />
              <span>{BUG_TEXT.privacy}</span>
            </div>
          </div>
          <div className="flex flex-col gap-2.5 border-t border-line p-6">
            <SendStatus r={r} />
            <p className="text-xs text-text-2" data-testid="bug-goes-to">
              {r.goesTo}
            </p>
            <div className="flex gap-2.5">
              <Button variant="outline" onClick={r.close} className="flex-1">
                {r.sent ? BUG_TEXT.done : BUG_TEXT.cancel}
              </Button>
              <Button onClick={r.send} disabled={r.sending || r.sent || r.gathering} className="flex-[2]">
                {r.sending ? BUG_TEXT.sending : r.gathering ? BUG_TEXT.gathering : BUG_TEXT.send}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
