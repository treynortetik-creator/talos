import { z } from 'zod'

/**
 * hook -> hub: the last line of a PermissionRequest hook that KNOWS its prompt has ended, sent on the connection that carried its `perm`,
 * just before it exits. `why`: `term` or `hup` (Claude Code stopped the hook, which it does when the prompt is answered anywhere, or
 * pressed Esc on, but not once 3500 s have passed: Claude Code's own hook timeout stops it the same way), `parent` (Claude Code itself is
 * gone). A hook that crashed, saw the call's own tool_result (that can belong to another session's identical call),
 * was killed outright (SIGKILL), ran out of its own wait, or lost the hub sends nothing: the bridge then cannot tell and keeps the prompt
 * open. Only the connection's own request id counts. Loose, like `perm`: a newer hook's extra fields never break an older hub.
 */
export const HubPermOver = z.looseObject({
  t: z.literal('perm_over'),
  id: z.string().min(1).max(64),
  why: z.string().max(20).optional(),
})
export type HubPermOverT = z.infer<typeof HubPermOver>

/**
 * What a `perm` line may say about the call it is for, when the hook could tie it to exactly one PreToolUse record of its own session:
 * the call's tool_use id, the subagent's id when the call is a subagent's, and the transcript path Claude Code gave the hook. The bridge
 * checks the path's shape itself before it reads anything (`safeTranscriptPath`). Each is optional and reads as none when it is not text of a
 * sane size, so an older hook, or a newer one, never breaks the line.
 */
export const HubPermToolUse = {
  tool_use_id: z.string().max(100).optional().catch(undefined),
  agent_id: z.string().max(100).optional().catch(undefined),
  transcript_path: z.string().max(1000).optional().catch(undefined),
}
