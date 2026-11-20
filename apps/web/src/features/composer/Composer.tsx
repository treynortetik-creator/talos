// Composer (8.3): + attach, text field and Send. (The voice-note mic, Dictate and the live call were archived on 2026-11-19:
// tag archive/voice-2026-11-19, docs/archived/voice.md.)
// This file lays the pieces out; the state and effects live in the hooks beside it (useComposerDraft, useComposerTextBox,
// useComposerSend, useComposerKeyboard, useComposerAttachments) and the parts in ComposerToolbar, ComposerChips and
// ComposerNotices.
import { ownValue } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTalosClient } from '../../lib/client.ts'
import { useStorage } from '../../lib/storageContext.tsx'
import { SlashPicker, useSlashPicker } from '../session/SlashPicker.tsx'
import { useSessionController } from '../session/store.ts'
import { useWorkingStop } from '../threads/WorkingRow.tsx'
import { ChipList, useChipUpkeep } from './ComposerChips.tsx'
import { ErrorLine, NoteLine, ReplyBar, TooLongBar } from './ComposerNotices.tsx'
import { ComposerToolbar } from './ComposerToolbar.tsx'
import { type Chip, EMPTY_CHIPS, useComposerStore } from './composerStore.ts'
import { useComposerAttachments } from './useComposerAttachments.ts'
import { useComposerDraft } from './useComposerDraft.ts'
import { useComposerKeyboard } from './useComposerKeyboard.ts'
import { type Note, useComposerSend, useThreadAlive } from './useComposerSend.ts'
import { useComposerTextBox } from './useComposerTextBox.ts'

export function Composer({ threadId, placeholder }: { threadId: string; placeholder?: string }) {
  const client = useTalosClient()
  const storage = useStorage()
  const [text, setText] = useState('')
  // Chips live in the store, per thread: switching threads and coming back keeps them, and an upload goes on meanwhile.
  const chips = useComposerStore((s) => ownValue(s.chips, threadId)) ?? EMPTY_CHIPS
  const storeSetChips = useComposerStore((s) => s.setChips)
  const setChips = useCallback(
    (next: Chip[] | ((cur: Chip[]) => Chip[])) => storeSetChips(threadId, next),
    [storeSetChips, threadId],
  )
  const replyTarget = useComposerStore((s) => ownValue(s.replyTo, threadId))
  const setReplyTo = useComposerStore((s) => s.setReplyTo)
  const [error, setError] = useState<string | null>(null)
  // CC-C3: the `/` picker and a calm note for session controls run from the box.
  const [note, setNote] = useState<Note | null>(null)
  const session = useSessionController()
  const working = useWorkingStop(threadId)
  const picker = useSlashPicker(text, threadId)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const alive = useThreadAlive(threadId)
  const chipsRef = useRef<HTMLUListElement>(null)
  const leftNote = useRef(false) // the "not sent" note below is showing

  useComposerDraft({ storage, threadId, text, setText, setError, taRef })
  const { syncFromDom, keepFocus, emptyBox } = useComposerTextBox({ taRef, text, setText })
  const { send, uploading, tooLong, canSend } = useComposerSend({
    client,
    storage,
    threadId,
    text,
    taRef,
    chips,
    setChips,
    replyTarget,
    setReplyTo,
    session,
    setText,
    setError,
    setNote,
    leftNote,
    alive,
    keepFocus,
    emptyBox,
  })
  const { choose, onKeyDown } = useComposerKeyboard({ picker, storage, threadId, taRef, setText, setNote, send })
  const att = useComposerAttachments({ client, storage, threadId, text, taRef, setText, setError })

  useChipUpkeep({ chips, chipsRef, leftNote, setNote })
  // The "waiting for the upload" line goes once the upload has settled (ready, failed or removed)
  useEffect(() => {
    if (!uploading) setNote((n) => (n?.text.startsWith('Waiting for the upload') ? null : n))
  }, [uploading])
  return (
    <div
      className="composer-root relative border-t border-line bg-bg px-3 pt-2 pb-[max(0.5rem,var(--safe-b))]"
      data-testid="composer"
    >
      <SlashPicker picker={picker} onChoose={(it) => void choose(it)} />
      {note && <NoteLine note={note} />}
      {error && <ErrorLine error={error} />}
      {tooLong && <TooLongBar length={text.length} uploading={uploading} onSendAsFile={() => void att.sendAsFile()} />}
      {replyTarget && <ReplyBar target={replyTarget} onCancel={() => setReplyTo(threadId, undefined)} />}
      {chips.length > 0 && (
        <ChipList
          chips={chips}
          chipsRef={chipsRef}
          client={client}
          threadId={threadId}
          clearIfUnchanged={att.clearIfUnchanged}
        />
      )}

      {working.stopError && (
        <p role="alert" data-testid="working-row-error" className="m-0 pb-1.5 text-sm text-danger">
          {working.stopError}
        </p>
      )}
      <ComposerToolbar
        placeholder={placeholder}
        text={text}
        setText={setText}
        clearNote={() => setNote(null)}
        taRef={taRef}
        syncFromDom={syncFromDom}
        onKeyDown={onKeyDown}
        onPaste={att.onPaste}
        picker={picker}
        menuOpen={att.menuOpen}
        setMenuOpen={att.setMenuOpen}
        choseOnce={att.choseOnce}
        pickerRef={att.pickerRef}
        onPick={att.onPick}
        choosePicker={att.choosePicker}
        attachMode={att.attachMode()}
        openIosSheet={att.openIosSheet}
        canSend={canSend}
        waiting={uploading}
        tooLong={tooLong}
        working={working}
        onSend={() => void send()}
      />
    </div>
  )
}
