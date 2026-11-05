// Pins the protocol's lists of agent tool names, contents and order. Written before they were derived from one table,
// and left alone since: moving a tool between lists, or reordering one, fails here.
import { describe, expect, it } from 'vitest'
import {
  ATTACHMENT_BRIDGE_TOOLS,
  BRIDGE_TOOLS,
  CONFIG_BRIDGE_TOOLS,
  MOD_BRIDGE_TOOLS,
  SCHEDULE_BRIDGE_TOOLS,
  SESSION_BRIDGE_TOOLS,
  WORKER_BRIDGE_TOOLS,
  WORKER_THREAD_LOCKED_TOOLS,
} from '../src/index.ts'

describe('agent tool name lists', () => {
  it('hold exactly these names in this order', () => {
    expect([...BRIDGE_TOOLS]).toEqual([
      'reply',
      'attach',
      'card',
      'card_result',
      'set_status',
      'voice_progress',
      'list_threads',
      'create_thread',
      'archive_thread',
      'read_thread',
      'inbox_triage',
      'inbox_raw',
    ])
    expect([...SCHEDULE_BRIDGE_TOOLS]).toEqual([
      'schedules_list',
      'schedule_propose',
      'schedule_run_start',
      'schedule_run_done',
    ])
    expect([...CONFIG_BRIDGE_TOOLS]).toEqual(['config_propose'])
    expect([...ATTACHMENT_BRIDGE_TOOLS]).toEqual(['retry_attachment'])
    expect([...SESSION_BRIDGE_TOOLS]).toEqual(['session_report'])
    expect([...MOD_BRIDGE_TOOLS]).toEqual(['talos_mod_hello', 'talos_mod_sync'])
  })

  it('give a worker these tools, and lock these to its thread', () => {
    expect([...WORKER_BRIDGE_TOOLS]).toEqual([
      'reply',
      'attach',
      'card',
      'card_result',
      'set_status',
      'list_threads',
      'read_thread',
      'schedules_list',
      'schedule_propose',
      'schedule_run_start',
      'schedule_run_done',
      'read_inbound',
      'handoff',
    ])
    expect([...WORKER_THREAD_LOCKED_TOOLS]).toEqual([
      'reply',
      'attach',
      'card',
      'set_status',
      'read_thread',
      'schedule_propose',
      'handoff',
    ])
  })
})
