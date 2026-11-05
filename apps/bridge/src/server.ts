#!/usr/bin/env bun
// MCP stdio server entry (spec 4.1). Registered in the AGENT FOLDER's .mcp.json, never user scope. Stdout is the MCP pipe:
// everything we log goes to $TALOS_APP_HOME/bridge.log.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  PERMISSION_CAPABILITY,
  PERMISSION_REQUEST_METHOD,
  PERMISSION_VERDICT_METHOD,
  ThreadId,
  trustOn,
} from '@talos-app/protocol'
import { z } from 'zod'
import { recordLiveVersion } from './apps/live-version.ts'
import { agentInstructions, Bridge } from './bridge.ts'
import { loadEnv, paths } from './config.ts'
import { recordHealthyStart } from './good-starts.ts'
import { agentDirFromEnv, saveLastGood } from './last-good.ts'
import { installLifecycle, installRejectionLogger, removePidFileIfOurs, takeOver, writePidFile } from './lifecycle.ts'
import { createLogger } from './log.ts'
import { ancestorCommandLines, otherChannelsFromLines } from './permission/doctor.ts'
import { APP_INSTRUCTIONS } from './tools/apps.ts'
import { toolTableProblems } from './tools/index.ts'
import {
  BRIDGE_COMMIT,
  BRIDGE_DIRTY,
  BRIDGE_VERSION,
  CHANNEL_CAPABILITY,
  MCP_SERVER_NAME,
  REPO_DIR,
} from './version.ts'

async function main() {
  const env = loadEnv()
  const p = paths(env.home)
  const log = createLogger(env.home, env.logLevel)
  installRejectionLogger(log)
  const tableProblems = toolTableProblems()
  if (tableProblems.length > 0) {
    for (const why of tableProblems) log.error('agent tool table does not match its tools', { reason: why })
    process.stderr.write(`talos-app bridge: ${tableProblems.join('; ')}\n`)
    process.exit(1)
  }
  // Option C worker mode is fail-closed (docs/OPTION-C.md): a thread session never takes over bridge.pid, never opens
  // the relay socket, and refuses to start at all when it is also told to be the live bridge.
  if (env.workerThread !== undefined) {
    const why = !ThreadId.safeParse(env.workerThread).success
      ? 'TALOS_APP_WORKER_THREAD is not a thread id'
      : env.live
        ? 'TALOS_APP_WORKER_THREAD and TALOS_APP_BRIDGE=1 are both set; a thread session is never the live bridge'
        : undefined
    if (why) {
      log.error('worker mode refused', { reason: why })
      process.stderr.write(`talos-app bridge: ${why}\n`)
      process.exit(2)
    }
  }
  const worker = env.workerThread !== undefined
  let instance: string | undefined
  if (env.live) {
    await takeOver(p, log)
    instance = writePidFile(p).instance
  }

  let bridge: Bridge
  try {
    bridge = await Bridge.create({
      env,
      logger: log,
      // test builds only: a spawned bridge in a test polls fast instead of every 10 s
      ...(env.nodeEnv === 'test' && Number(process.env.TALOS_APP_POLL_MS) >= 50
        ? { pollMs: Number(process.env.TALOS_APP_POLL_MS) }
        : {}),
      ...(instance ? { instance } : {}),
      // the version `talos-app rollback` can return to: recorded when the relay answers, not merely when the process starts
      onHealthyStart: () => {
        const r = recordHealthyStart({ file: p.goodStarts, repoDir: REPO_DIR, started: BRIDGE_COMMIT })
        if (!r.ok) log.info('this start was not recorded for rollback', { why: r.why })
        // the agent's Claude Code setup as it is on a start that went well, for `talos-app restore-last-good`. The agent folder
        // comes from TALOS_AGENT_DIR (install-mcp writes it into the .mcp.json entry); the working folder here is the bridge's
        // own. Deferred so it can never hold up the start; a failure only logs.
        const agentDir = agentDirFromEnv(process.env)
        if (!agentDir)
          log.warn(
            'last-good: not saved, TALOS_AGENT_DIR is not set (run talos-app install-mcp --agent-dir <dir> again)',
          )
        else if (!existsSync(agentDir))
          log.warn(
            `last-good: not saved, TALOS_AGENT_DIR does not exist: ${agentDir} (run talos-app install-mcp --agent-dir <dir> again)`,
          )
        else setImmediate(() => saveLastGood({ agentDir, dir: join(p.home, 'last-good'), log }))
      },
    })
  } catch (e) {
    log.error('bridge failed to start', { error: (e as Error).message })
    process.stderr.write(`talos-app bridge: ${(e as Error).message}\n`)
    if (instance) removePidFileIfOurs(p, instance)
    process.exit(1)
  }

  // Declared only when the owner turned the relay on: Claude Code sends permission_request to a server that declared it.
  // A worker is not a channel (no --channels, nothing to push) and relays no permission prompts.
  const experimental: Record<string, object> = worker ? {} : { [CHANNEL_CAPABILITY]: {} }
  const declarePermission = bridge.permissionRelayEnabled && !worker
  if (declarePermission) experimental[PERMISSION_CAPABILITY] = {}
  // remembered, so a switch turned on later is reported as "after restart" instead of silently doing nothing
  if (!worker) bridge.declarePermissionRelay(declarePermission)
  const mcp = new Server(
    { name: MCP_SERVER_NAME, version: BRIDGE_VERSION },
    {
      capabilities: { tools: {}, experimental },
      instructions: agentInstructions({
        worker: Boolean(worker),
        appInstructions: env.apps ? APP_INSTRUCTIONS : undefined,
        trust: trustOn(bridge.ctx.config.config),
        // the relay reports no version in hello or ready (only /healthz), so none is passed and the line is left out
        self: { bridgeDir: REPO_DIR, commit: BRIDGE_COMMIT, dirty: BRIDGE_DIRTY },
      }),
    },
  )
  if (declarePermission) {
    mcp.setNotificationHandler(
      z.object({ method: z.literal(PERMISSION_REQUEST_METHOD), params: z.unknown() }),
      async (n) => {
        await bridge.ctx.permission.onRequest(n.params)
      },
    )
    bridge.setClientVersion(() => mcp.getClientVersion()?.version)
    // another loaded channel (another channel plugin, say) can answer the same prompt: a one-line note on each card, no block
    // TALOS_APP_OTHER_CHANNELS (comma list, may be empty) overrides the detection, for tests and odd launchers
    const forced = process.env.TALOS_APP_OTHER_CHANNELS
    const others =
      forced !== undefined
        ? forced
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean)
        : otherChannelsFromLines(ancestorCommandLines())
    bridge.ctx.permission.setOtherChannels(others)
    if (others.length > 0) log.warn('other channels can also approve permission prompts', { channels: others })
    bridge.setPermissionSender(async (v) => {
      await mcp.notification({ method: PERMISSION_VERDICT_METHOD, params: v } as never)
    })
  }
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: bridge.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }))
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    return bridge.callTool(req.params.name, args)
  })
  bridge.setEmit(async (n) => {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: n.content, meta: n.meta },
    } as never)
  })

  installLifecycle({
    log,
    shutdown: async () => {
      await bridge.stop()
      if (instance) removePidFileIfOurs(p, instance)
      await mcp.close().catch(() => {})
    },
  })

  // F5: the relay replays every unconsumed frame right after `ready`, and each one is acked `consumed` once its channel
  // notification is written. Claude Code may still be showing the dev-channel dialog, so connect to the relay only after
  // it has sent notifications/initialized. Until then nothing is pushed and nothing is acked, so the relay keeps the backlog.
  mcp.oninitialized = () => {
    // MCP apps: the live Claude Code version, so a scan on another version stops (MCP-APPS-SPEC M5.1 step 1)
    if (env.live && env.apps) recordLiveVersion(p.home, mcp.getClientVersion()?.version, log)
    if (env.live) bridge.start()
    if (worker) void bridge.startWorker()
    log.info('mcp initialized', { mode: bridge.live ? 'live' : worker ? 'worker' : 'headless' })
  }
  await mcp.connect(new StdioServerTransport())
  log.info('bridge up', { mode: bridge.live ? 'live' : worker ? 'worker' : 'headless', version: BRIDGE_VERSION })
}

main().catch((e) => {
  process.stderr.write(`talos-app bridge: ${(e as Error).message}\n`)
  process.exit(1)
})
