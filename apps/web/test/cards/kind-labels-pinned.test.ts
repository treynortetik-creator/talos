// The label and icon text shown for each card kind, in kind order.
import { Card } from '@talos-app/protocol'
import { describe, expect, it } from 'vitest'
import { KIND_LABEL } from '../../src/features/cards/logic.ts'

describe('card kind labels', () => {
  it('has the same labels and icons for every kind, in kind order', () => {
    expect(Object.entries(KIND_LABEL)).toEqual([
      ['email', { icon: '✉', label: 'Email' }],
      ['message', { icon: '💬', label: 'Message' }],
      ['deploy', { icon: '🚀', label: 'Deploy' }],
      ['publish', { icon: '📣', label: 'Publish' }],
      ['purchase', { icon: '💳', label: 'Purchase' }],
      ['decision', { icon: '⚖', label: 'Decision' }],
      ['generic', { icon: '◇', label: 'Card' }],
      ['schedule', { icon: '⏱', label: 'Schedule' }],
      ['permission', { icon: '⚠', label: 'Permission' }],
      ['app_action', { icon: '◇', label: 'App request' }],
      ['config', { icon: '⚙', label: 'Setting' }],
    ])
    expect(Object.keys(KIND_LABEL)).toEqual([...Card.shape.kind.options])
  })
})
