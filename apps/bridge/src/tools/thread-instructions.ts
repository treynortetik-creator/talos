// `set_thread_instructions`: the AGENTS.md of a thread agent the caller set up (thread-setup.ts has the rules).
import { fail } from './common.ts'
import { type ToolRecord, WORKER_NO_THREAD } from './define.ts'
import { viaMain } from './schedules.ts'
import { AGENT_INSTRUCTIONS_MAX_BYTES, setInstructionsAs } from './thread-setup.ts'

export const setThreadInstructions: ToolRecord = {
  name: 'set_thread_instructions',
  group: 'config',
  headless: false,
  ...WORKER_NO_THREAD,
  instructions: null,
  told: [],
  description: `Write the instructions (AGENTS.md) of a thread agent into its own folder: a thread with its own session and a folder that is not the shared agent folder. Main: any such thread. A thread's own session: its own sub-threads only (its own instructions are the owner's). Up to ${AGENT_INSTRUCTIONS_MAX_BYTES / 1024} KB; a link is never followed; the text it replaces is kept as agents-md.prev, and the owner is told, with how to undo it. Refused while "Lock Talos settings" is on, or when something from outside reached you since the owner last spoke (he can write it in the thread's settings). The thread's next session start reads it.`,
  liveOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The id of the thread whose instructions these are.' },
      text: { type: 'string', description: 'The whole AGENTS.md text; it replaces the file.' },
    },
    required: ['id', 'text'],
  },
  async handler(ctx, args) {
    if (ctx.worker) return viaMain(ctx, 'set_thread_instructions', args)
    if (ctx.mode !== 'live') return fail('set_thread_instructions is for the main session of a live bridge.')
    return setInstructionsAs(ctx, args)
  },
}
