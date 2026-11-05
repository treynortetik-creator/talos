// `app_show`, `app_result`, `list_apps` (MCP-APPS-SPEC M5.3). Registered only when the owner turned apps on.
import { AppToolError } from '../apps/service.ts'
import { fail, needStr, ok, str, type Tool, threadArg, threadProps } from './common.ts'
import { toolInstructions } from './instructions.ts'

function service(ctx: Parameters<Tool['handler']>[0]) {
  if (!ctx.apps) throw new AppToolError('Apps are not available in this session.')
  return ctx.apps
}

export const appShow: Tool = {
  name: 'app_show',
  liveOnly: true,
  description:
    'Show the app view of a connector result in a thread. Call it after a Talos note gives a capture id, when the result is worth seeing. Never paste HTML or the result yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      ...threadProps,
      capture_id: { type: 'string', description: 'The capture id from the Talos note.' },
      caption: { type: 'string', description: 'Up to 280 characters, markdown.' },
    },
    required: ['thread_id', 'capture_id'],
  },
  async handler(ctx, args) {
    try {
      const svc = service(ctx)
      const thread = threadArg(ctx, args)
      const capture = needStr(args, 'capture_id', 100)
      const caption = str(args.caption)
      if (caption !== undefined && caption.length > 280) throw new AppToolError('caption is over 280 characters')
      return ok(await svc.show({ threadId: thread, captureId: capture, caption }))
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const appResult: Tool = {
  name: 'app_result',
  liveOnly: true,
  description: 'Refuse an app request you were told about and cannot run: ok must be false.',
  inputSchema: {
    type: 'object',
    properties: {
      request_id: { type: 'string' },
      ok: { type: 'boolean', description: 'Always false: results of app calls go to the app by themselves.' },
      text: { type: 'string', description: 'Up to 2000 characters.' },
    },
    required: ['request_id', 'ok'],
  },
  async handler(ctx, args) {
    try {
      const svc = service(ctx)
      const id = needStr(args, 'request_id', 100)
      if (args.ok !== false)
        throw new AppToolError('app_result is for refusals only: pass ok:false. Results reach the app on their own.')
      const text = str(args.text)
      if (text !== undefined && text.length > 2000) throw new AppToolError('text is over 2000 characters')
      return ok(await svc.decline(id, text))
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

export const listApps: Tool = {
  name: 'list_apps',
  liveOnly: true,
  description: 'The apps the owner approved: label, server, which tools show a view, and which tools an app may call.',
  inputSchema: { type: 'object', properties: {} },
  async handler(ctx) {
    try {
      return ok(service(ctx).listApps())
    } catch (e) {
      return fail((e as Error).message)
    }
  },
}

/** The tools in this file; tools/index.ts checks it against the `apps` rows of AGENT_TOOLS. */
export const APP_TOOLS: Tool[] = [appShow, appResult, listApps]

/** Appended to the bridge instructions when apps are on (M5.3). */
export const APP_INSTRUCTIONS = toolInstructions('app_show')
