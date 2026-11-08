// `retry_attachment`: brings back an owner attachment whose download failed (see ../attachment-retry.ts).
import { retryAttachment } from '../attachment-retry.ts'
import { fail, needStr, ok, ToolError } from './common.ts'
import { NOT_FOR_WORKERS, type ToolRecord } from './define.ts'

export const retryAttachmentTool: ToolRecord = {
  name: 'retry_attachment',
  group: 'attachment',
  headless: false,
  ...NOT_FOR_WORKERS,
  instructions: `If a note says an attachment could not be downloaded, call \`retry_attachment\` with the media_id it names; if that still fails, tell the owner.`,
  told: ['main'],
  liveOnly: true,
  description:
    'Try again to download an attachment the owner sent that could not be downloaded (the note in the message names its media_id). Answers with the file path on success, or why it still failed.',
  inputSchema: {
    type: 'object',
    properties: { media_id: { type: 'string', description: 'The media_id named in the message note.' } },
    required: ['media_id'],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    try {
      return ok(await retryAttachment(ctx, needStr(args, 'media_id', 64)))
    } catch (e) {
      return fail(e instanceof ToolError || e instanceof Error ? e.message : String(e))
    }
  },
}
