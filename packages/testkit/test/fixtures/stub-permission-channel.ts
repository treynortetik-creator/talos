// A tiny channel server that opts in to the permission relay, used ONLY to test FakeClaude's permission side.
// Run with Bun. Env: PERMISSION ("0" = do not declare the capability), ANSWER ("allow" | "deny" | "wrong_id" |
// "none"). On every permission_request it sends one verdict for the request id it got (or a wrong id).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  PERMISSION_CAPABILITY,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
  PermissionRequestParams,
} from '@talos-app/protocol'
import { z } from 'zod'

const env = process.env as Record<string, string>
const experimental: Record<string, object> = { 'claude/channel': {} }
if (env.PERMISSION !== '0') experimental[PERMISSION_CAPABILITY] = {}

const server = new Server(
  { name: 'stub-permission-channel', version: '0.0.0' },
  { capabilities: { experimental }, instructions: 'Stub channel for the permission relay.' },
)

const Req = z.object({ method: z.literal(PERMISSION_REQUEST_METHOD), params: PermissionRequestParams })
server.setNotificationHandler(Req, async ({ params }) => {
  const answer = env.ANSWER ?? 'allow'
  if (answer === 'none') return
  const request_id = answer === 'wrong_id' ? 'zzzzz' : params.request_id
  const behavior = answer === 'deny' ? 'deny' : 'allow'
  await server.notification({ method: PERMISSION_VERDICT_METHOD, params: { request_id, behavior } })
})

await server.connect(new StdioServerTransport())
