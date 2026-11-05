// The card kinds are one table (CARD_KIND_MINTER); the app's label and icon tables must have an entry for each kind.
import { CARD_KINDS, type CardKind } from '@talos-app/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KIND_ICON } from '../../src/features/cards/CardView.tsx'
import { KIND_LABEL } from '../../src/features/cards/logic.ts'
import {
  IconAlert,
  IconCardPay,
  IconChat,
  IconClock,
  IconDiamond,
  IconMail,
  IconMegaphone,
  IconRocket,
  IconScale,
  IconSettings,
} from '../../src/ui/icons.tsx'

const draw = (I: (typeof KIND_ICON)[CardKind]) => renderToStaticMarkup(createElement(I))

describe('card kind table', () => {
  it('fails the type check when a kind has no label', () => {
    // @ts-expect-error `config` is missing, so this is not a label for every kind
    const incomplete: typeof KIND_LABEL = { ...omit(KIND_LABEL, 'config') }
    expect(Object.keys(incomplete)).not.toContain('config')
  })

  it('fails the type check when a kind has no icon', () => {
    // @ts-expect-error `config` is missing, so this is not an icon for every kind
    const incomplete: typeof KIND_ICON = { ...omit(KIND_ICON, 'config') }
    expect(Object.keys(incomplete)).not.toContain('config')
  })

  it('has a label and an icon for each kind, and no others', () => {
    expect(Object.keys(KIND_LABEL)).toEqual([...CARD_KINDS])
    expect(Object.keys(KIND_ICON)).toEqual([...CARD_KINDS])
  })

  it('draws the pinned icon for each kind', () => {
    const expected: Record<CardKind, Parameters<typeof draw>[0]> = {
      email: IconMail,
      message: IconChat,
      deploy: IconRocket,
      publish: IconMegaphone,
      purchase: IconCardPay,
      decision: IconScale,
      generic: IconDiamond,
      schedule: IconClock,
      permission: IconAlert,
      app_action: IconDiamond,
      config: IconSettings,
    }
    for (const kind of CARD_KINDS) expect(draw(KIND_ICON[kind]), kind).toBe(draw(expected[kind]))
    // The pin only means something if the icons differ from each other (the two diamonds aside).
    const distinct = new Set(CARD_KINDS.map((k) => draw(KIND_ICON[k])))
    expect(distinct.size).toBe(CARD_KINDS.length - 1)
  })
})

function omit<T extends object, K extends keyof T>(o: T, k: K): Omit<T, K> {
  const { [k]: _gone, ...rest } = o
  return rest
}
