// Per-kind parity: every card kind behaves as it did when each rule kept its own hand-written list. The OLD column is
// pinned here as literals (copied from the lists the table replaced); the NEW side runs the real functions.
import { describe, expect, it } from 'vitest'
import {
  AGENT_CARD_KINDS,
  BRIDGE_ONLY_CARD_KINDS,
  CARD_KIND_TABLE,
  CARD_KINDS,
  type CardKind,
  cardNotice,
  isAgentCardKind,
  isBodyEditable,
  isBridgeHandledCardKind,
  NATIVE_APPROVABLE_KINDS,
  riskForTrust,
  validateCard,
} from '../src/index.ts'

type Old = {
  minter: 'agent' | 'bridge'
  label: string
  glyph: string
  bodyEditable: boolean
  destinationOptional: boolean
  nativeApprovable: boolean
  highRiskUnderTrust: boolean
  bridgeHandled: boolean
}
const agent = { minter: 'agent', bridgeHandled: false, highRiskUnderTrust: false } as const
const bridge = { minter: 'bridge', bridgeHandled: false, highRiskUnderTrust: false } as const
const OLD: Record<CardKind, Old> = {
  email: {
    ...agent,
    label: 'Email',
    glyph: '✉',
    bodyEditable: true,
    destinationOptional: false,
    nativeApprovable: false,
  },
  message: {
    ...agent,
    label: 'Message',
    glyph: '💬',
    bodyEditable: true,
    destinationOptional: false,
    nativeApprovable: false,
  },
  deploy: {
    ...agent,
    label: 'Deploy',
    glyph: '🚀',
    bodyEditable: false,
    destinationOptional: false,
    nativeApprovable: false,
  },
  publish: {
    ...agent,
    label: 'Publish',
    glyph: '📣',
    bodyEditable: true,
    destinationOptional: false,
    nativeApprovable: false,
  },
  purchase: {
    ...agent,
    highRiskUnderTrust: true,
    label: 'Purchase',
    glyph: '💳',
    bodyEditable: false,
    destinationOptional: false,
    nativeApprovable: false,
  },
  decision: {
    ...agent,
    label: 'Decision',
    glyph: '⚖',
    bodyEditable: false,
    destinationOptional: true,
    nativeApprovable: true,
  },
  generic: {
    ...agent,
    label: 'Card',
    glyph: '◇',
    bodyEditable: false,
    destinationOptional: true,
    nativeApprovable: true,
  },
  schedule: {
    ...bridge,
    label: 'Schedule',
    glyph: '⏱',
    bodyEditable: false,
    destinationOptional: false,
    nativeApprovable: false,
  },
  permission: {
    ...bridge,
    bridgeHandled: true,
    label: 'Permission',
    glyph: '⚠',
    bodyEditable: false,
    destinationOptional: true,
    nativeApprovable: true,
  },
  app_action: {
    ...bridge,
    label: 'App request',
    glyph: '◇',
    bodyEditable: false,
    destinationOptional: false,
    nativeApprovable: false,
  },
  config: {
    ...bridge,
    bridgeHandled: true,
    label: 'Setting',
    glyph: '⚙',
    bodyEditable: false,
    destinationOptional: false,
    nativeApprovable: false,
  },
  dialog: {
    ...bridge,
    bridgeHandled: true,
    label: 'Needs you',
    glyph: '⌨',
    bodyEditable: false,
    destinationOptional: true,
    nativeApprovable: false,
  },
}

const plain = {
  risk: 'low' as const,
  body_format: 'plain' as const,
  allow_edit: false,
  allow_revise: false,
  title: 'T',
  summary: undefined,
  destination: [],
  body: undefined,
  fields: [],
  warning: undefined,
  primary_label: 'Go',
  attachments: [],
  payload: undefined,
}

describe('card kind table: each kind behaves as before', () => {
  it('has exactly the old kinds, in the old order', () => {
    expect([...CARD_KINDS]).toEqual(Object.keys(OLD))
    expect(Object.keys(CARD_KIND_TABLE)).toEqual(Object.keys(OLD))
  })

  it.each(Object.keys(OLD) as CardKind[])('%s', (kind) => {
    const old = OLD[kind]
    expect(CARD_KIND_TABLE[kind].minter).toBe(old.minter)
    expect(isAgentCardKind(kind)).toBe(old.minter === 'agent')
    expect(AGENT_CARD_KINDS.includes(kind as never)).toBe(old.minter === 'agent')
    expect(BRIDGE_ONLY_CARD_KINDS.includes(kind as never)).toBe(old.minter === 'bridge')
    expect({ label: CARD_KIND_TABLE[kind].label, glyph: CARD_KIND_TABLE[kind].glyph }).toEqual({
      label: old.label,
      glyph: old.glyph,
    })
    expect(isBodyEditable({ allow_edit: true, kind })).toBe(old.bodyEditable)
    expect(isBodyEditable({ allow_edit: false, kind })).toBe(false)
    const now = '2026-01-01T00:00:00.000Z'
    const later = '2026-01-01T01:00:00.000Z'
    const issues = validateCard({ kind, destination: [], payload: undefined, created_at: now, expires_at: later })
    expect(issues.includes('destination_required')).toBe(!old.destinationOptional)
    expect(riskForTrust(true, kind, 'low')).toBe(old.highRiskUnderTrust ? 'high' : 'low')
    expect(riskForTrust(false, kind, 'low')).toBe('low')
    expect(NATIVE_APPROVABLE_KINDS.includes(kind)).toBe(old.nativeApprovable)
    // The real notice builder: a plain card with no destination is "complete" (offers Approve) only for approvable
    // kinds. A permission card also needs its own composed payload, so it is judged by its own rule elsewhere.
    if (kind !== 'permission') expect(cardNotice({ ...plain, kind }).complete).toBe(old.nativeApprovable)
    expect(isBridgeHandledCardKind(kind)).toBe(old.bridgeHandled)
  })

  it('treats a kind from a newer peer as none of these', () => {
    for (const k of ['telepathy', 'constructor', '__proto__', 'toString', '']) {
      expect(isAgentCardKind(k)).toBe(false)
      expect(isBridgeHandledCardKind(k)).toBe(false)
      expect(NATIVE_APPROVABLE_KINDS.includes(k)).toBe(false)
      expect(isBodyEditable({ allow_edit: true, kind: k as never })).toBe(false)
      expect(riskForTrust(true, k, 'high')).toBe('low')
    }
  })
})
