// Composer (8.3): + attach, text field, mic (hold / slide up to lock / slide left to cancel / tap to lock) and the
// live-call waveform (shown only when the field is empty, replaced by Send when typing).
// This file lays the pieces out; the state and effects live in the hooks beside it (useComposerDraft, useComposerTextBox,
// useComposerSend, useComposerKeyboard, useComposerAttachments, useComposerVoice) and the parts in ComposerToolbar,
// ComposerChips, ComposerNotices and RecorderLockedRow.
import { ownValue } from '@talos-app/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTalos, useTalosClient } from '../../lib/client.ts'
import { useStorage } from '../../lib/storageContext.tsx'
import { SlashPicker, useSlashPicker } from '../session/SlashPicker.tsx'
import { useSessionController } from '../session/store.ts'
import { CallErrorLine } from '../voice/CallErrorLine.tsx'
import { ChipList, useChipUpkeep } from './ComposerChips.tsx'
import { ErrorLine, NoteLine, ReplyBar, TooLongBar } from './ComposerNotices.tsx'
import { ComposerToolbar } from './ComposerToolbar.tsx'
import { type Chip, EMPTY_CHIPS, useComposerStore } from './composerStore.ts'
import { RecorderLockedRow } from './RecorderLockedRow.tsx'
import { useComposerAttachments } from './useComposerAttachments.ts'
import { useComposerDictate } from './useComposerDictate.tsx'
import { useComposerDraft } from './useComposerDraft.ts'
import { useComposerKeyboard } from './useComposerKeyboard.ts'
import { type Note, useComposerSend, useThreadAlive } from './useComposerSend.ts'
import { useComposerTextBox } from './useComposerTextBox.ts'
import { canQueue, useComposerVoice, useMicGesture, useRecorderState } from './useComposerVoice.ts'

export function Composer({
  threadId,
  placeholder,
  onCall,
}: {
  threadId: string
  placeholder?: string
  /** A live call is going on in this thread: WP4's CallBar replaces the composer (mounted by the caller). */
  onCall?: boolean
}) {
  const client = useTalosClient()
  const storage = useStorage()
  const macOnline = useTalos((s) => s.presence.bridge_online)
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
  const rec = useRecorderState()
  const [error, setError] = useState<string | null>(null)
  // CC-C3: the `/` picker and a calm note for session controls run from the box.
  const [note, setNote] = useState<Note | null>(null)
  const session = useSessionController()
  const picker = useSlashPicker(text, threadId)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const alive = useThreadAlive(threadId)
  const chipsRef = useRef<HTMLUListElement>(null)
  const leftNote = useRef(false) // the "not sent" note below is showing

  useComposerDraft({ storage, threadId, text, setText, setError, taRef })
  const recording = rec.mode !== 'idle'
  const { syncFromDom, keepFocus, emptyBox } = useComposerTextBox({ taRef, text, setText, recording })
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
  const att = useComposerAttachments({ client, storage, threadId, text, taRef, setText })
  const voice = useComposerVoice({ client, threadId, setError, rec })

  // Dictation (useComposerDictate): the words go in the box like typed ones; nothing here sends.
  const dictation = useComposerDictate({
    threadId,
    box: taRef,
    text,
    setText,
    clearNote: () => setNote(null),
    sendRecording: voice.sendRecording,
    // A 401 from dictation ends the session the same way a refused upload does.
    endSession: (reason) => {
      if (canQueue(client)) client.meta.setState((m) => ({ ...m, authFailed: true, authReason: reason }))
    },
  })
  const mic = useMicGesture({
    rec,
    dictationBusy: dictation.busy,
    begin: voice.begin,
    discard: voice.discard,
    finish: voice.finish,
  })

  useChipUpkeep({ chips, chipsRef, leftNote, setNote })
  // Recording replaces the row and unmounts the menu without telling it: close it so it cannot come back open.
  const { setMenuOpen } = att
  // biome-ignore lint/correctness/useExhaustiveDependencies: setMenuOpen is a state setter; the list is kept as it was
  useEffect(() => {
    if (rec.mode !== 'idle') setMenuOpen(false)
  }, [rec.mode])

  if (onCall) return null

  return (
    <div
      className="composer-root relative border-t border-line bg-bg px-3 pt-2 pb-[max(0.5rem,var(--safe-b))]"
      data-testid="composer"
    >
      <SlashPicker picker={picker} onChoose={(it) => void choose(it)} />
      {note && <NoteLine note={note} />}
      {dictation.strip}
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

      <CallErrorLine threadId={threadId} />

      {rec.mode === 'locked' ? (
        <RecorderLockedRow
          elapsed={rec.elapsed}
          paused={rec.paused}
          preview={rec.preview}
          onCancel={() => void voice.discard()}
          onTogglePause={() => void voice.togglePause()}
          onSend={() => void voice.finish(true)}
        />
      ) : (
        <ComposerToolbar
          threadId={threadId}
          placeholder={placeholder}
          mode={rec.mode}
          hint={rec.hint}
          elapsed={rec.elapsed}
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
          dictationButton={dictation.button}
          dictationBusy={dictation.busy}
          canSend={canSend}
          tooLong={tooLong}
          macOnline={macOnline}
          onSend={() => void send()}
          mic={mic}
        />
      )}
    </div>
  )
}
