// The names a thread's own session goes by, the same on both sides (split out of thread-sessions.ts to keep that file under its size limit).

/** The worker's tmux session on the supervisor's private socket (`tmux -L talos`). Thread ids are tmux-safe. */
export const workerTmuxName = (threadId: string) => `t-${threadId}`
/** The worker's `--name` (shown in `claude agents`, the target of cross-session `SendMessage` from main). */
export const workerSessionName = (threadId: string) => `talos-${threadId}`
