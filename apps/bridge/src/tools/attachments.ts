// `retry_attachment`: brings back an owner attachment whose download failed (see ../attachment-retry.ts).
import { retryAttachment } from '../attachment-retry.ts'
import { fail, needStr, ok, type Tool, ToolError } from './common.ts'

export const retryAttachmentTool: Tool = {
  name: 'retry_attachment',
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
