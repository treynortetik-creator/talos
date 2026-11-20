// Voice input was archived 2026-11-19 (docs/archived/voice.md). An older build may have left a voice note or a voice.ask
// queued in this device's outbox: it is dropped on load (socket-outbox-queue.ts), never sent, and never counted as unsent.
export const isArchivedVoice = (e: { kind?: string }): boolean => e.kind === 'voice_note' || e.kind === 'voice.ask'
